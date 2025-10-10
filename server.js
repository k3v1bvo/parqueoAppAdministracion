import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET || 'parqueo_super_secret_key_2024';

// ==============================
// MIDDLEWARE DE AUTENTICACIÓN
// ==============================

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token de acceso requerido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    const { data: session, error } = await supabase
      .from('sesiones')
      .select('*, usuarios(*)')
      .eq('token', token)
      .gt('expira_en', new Date().toISOString())
      .single();

    if (error || !session) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }

    req.user = session.usuarios;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Token inválido' });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user.rol !== 'admin') {
    return res.status(403).json({ error: 'Se requieren permisos de administrador' });
  }
  next();
};

// ==============================
// RUTAS DE AUTENTICACIÓN
// ==============================

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña son requeridos" });
    }

    const { data: usuario, error } = await supabase
      .from("usuarios")
      .select("*")
      .eq("email", email.toLowerCase())
      .single();

    if (error || !usuario) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const passwordValid = await bcrypt.compare(password, usuario.password);
    if (!passwordValid) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const token = jwt.sign(
      { 
        userId: usuario.id, 
        email: usuario.email,
        rol: usuario.rol 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const expiraEn = new Date();
    expiraEn.setHours(expiraEn.getHours() + 24);

    const { error: sessionError } = await supabase
      .from("sesiones")
      .insert([{
        usuario_id: usuario.id,
        token: token,
        expira_en: expiraEn.toISOString()
      }]);

    if (sessionError) throw sessionError;

    res.json({
      success: true,
      token,
      user: {
        id: usuario.id,
        nombre: usuario.nombre,
        email: usuario.email,
        rol: usuario.rol
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/auth/logout", authenticateToken, async (req, res) => {
  try {
    const token = req.headers['authorization'].split(' ')[1];
    
    await supabase
      .from("sesiones")
      .delete()
      .eq("token", token);

    res.json({ success: true, message: "Sesión cerrada correctamente" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/auth/me", authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// ==============================
// RUTAS DE TICKETS (Vehículos)
// ==============================

app.post("/api/tickets", authenticateToken, async (req, res) => {
  try {
    const { placa, tipo_vehiculo } = req.body;
    
    if (!placa || !tipo_vehiculo) {
      return res.status(400).json({ error: "Placa y tipo de vehículo son requeridos" });
    }

    const { data, error } = await supabase
      .from("tickets")
      .insert([{ 
        placa_vehiculo: placa.toUpperCase(), 
        tipo_vehiculo, 
        hora_entrada: new Date().toISOString(),
        operador_id: req.user.id,
        estado: 'activo'
      }])
      .select(`
        *,
        usuarios!operador_id (nombre, email)
      `);

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/tickets/activos", authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tickets")
      .select(`
        *,
        usuarios!operador_id (nombre, email)
      `)
      .is("hora_salida", null)
      .order("hora_entrada", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/tickets/salida/:id", authenticateToken, async (req, res) => {
  try {
    const id = req.params.id;
    const { data, error } = await supabase
      .from("tickets")
      .update({ 
        hora_salida: new Date().toISOString(),
        estado: 'finalizado'
      })
      .eq("id", id)
      .select(`
        *,
        usuarios!operador_id (nombre, email)
      `);

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==============================
// RUTAS DE INGRESOS EXTRA
// ==============================

app.post("/api/ingresos", authenticateToken, async (req, res) => {
  try {
    const { concepto, monto, descripcion } = req.body;
    
    if (!concepto || !monto) {
      return res.status(400).json({ error: "Concepto y monto son requeridos" });
    }

    const { data, error } = await supabase
      .from("tickets")
      .insert([{
        placa_vehiculo: `INGRESO-${Date.now()}`,
        tipo_vehiculo: 'ingreso_extra',
        hora_entrada: new Date().toISOString(),
        hora_salida: new Date().toISOString(),
        costo_total: parseFloat(monto),
        estado: 'pagado',
        tipo_pago: 'efectivo',
        operador_id: req.user.id,
        descripcion: `INGRESO EXTRA: ${concepto} - ${descripcion || 'Sin descripción adicional'}`
      }])
      .select(`
        *,
        usuarios!operador_id (nombre, email)
      `);

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/ingresos", authenticateToken, async (req, res) => {
  try {
    const { fecha } = req.query;
    let query = supabase
      .from("tickets")
      .select(`
        *,
        usuarios!operador_id (nombre, email)
      `)
      .eq("tipo_vehiculo", "ingreso_extra")
      .order("hora_entrada", { ascending: false });

    if (fecha) {
      query = query.gte("hora_entrada", fecha).lt("hora_entrada", `${fecha}T23:59:59`);
    }

    const { data, error } = await query;

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==============================
// RUTAS DE GASTOS
// ==============================

app.post("/api/gastos", authenticateToken, async (req, res) => {
  try {
    const { categoria, concepto, monto, descripcion } = req.body;
    
    if (!categoria || !concepto || !monto) {
      return res.status(400).json({ error: "Categoría, concepto y monto son requeridos" });
    }

    const { data, error } = await supabase
      .from("tickets")
      .insert([{
        placa_vehiculo: `GASTO-${Date.now()}`,
        tipo_vehiculo: 'gasto',
        hora_entrada: new Date().toISOString(),
        hora_salida: new Date().toISOString(),
        costo_total: -Math.abs(parseFloat(monto)),
        estado: 'pagado',
        tipo_pago: 'gasto',
        operador_id: req.user.id,
        categoria: categoria,
        descripcion: `GASTO [${categoria.toUpperCase()}]: ${concepto} - ${descripcion || 'Sin descripción adicional'}`
      }])
      .select(`
        *,
        usuarios!operador_id (nombre, email)
      `);

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/gastos", authenticateToken, async (req, res) => {
  try {
    const { fecha } = req.query;
    let query = supabase
      .from("tickets")
      .select(`
        *,
        usuarios!operador_id (nombre, email)
      `)
      .eq("tipo_vehiculo", "gasto")
      .order("hora_entrada", { ascending: false });

    if (fecha) {
      query = query.gte("hora_entrada", fecha).lt("hora_entrada", `${fecha}T23:59:59`);
    }

    const { data, error } = await query;

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==============================
// REPORTES FINANCIEROS COMPLETOS
// ==============================

app.get("/api/resumen/financiero", authenticateToken, async (req, res) => {
  try {
    const { fecha } = req.query;
    const targetDate = fecha || new Date().toISOString().split('T')[0];

    const { data: movimientos, error } = await supabase
      .from("tickets")
      .select(`
        *,
        usuarios!operador_id (nombre, email)
      `)
      .gte("hora_entrada", targetDate)
      .lt("hora_entrada", `${targetDate}T23:59:59`)
      .order("hora_entrada", { ascending: false });

    if (error) throw error;

    let ingresosTickets = 0;
    let ingresosExtra = 0;
    let gastosTotal = 0;

    const movimientosDetallados = movimientos.map(mov => {
      const monto = mov.costo_total || 0;
      let tipo = 'vehiculo';
      let concepto = mov.placa_vehiculo;

      if (mov.tipo_vehiculo === 'ingreso_extra') {
        ingresosExtra += monto;
        tipo = 'ingreso_extra';
        concepto = mov.descripcion?.replace('INGRESO EXTRA: ', '') || 'Ingreso extra';
      } else if (mov.tipo_vehiculo === 'gasto') {
        gastosTotal += Math.abs(monto);
        tipo = 'gasto';
        concepto = mov.descripcion?.replace('GASTO [', '')?.replace(']: ', ' - ') || 'Gasto';
      } else if (mov.tipo_vehiculo === 'auto' || mov.tipo_vehiculo === 'moto') {
        if (mov.costo_total > 0) {
          ingresosTickets += monto;
        }
        tipo = 'vehiculo';
        concepto = `${mov.placa_vehiculo} (${mov.tipo_vehiculo})`;
      }

      return {
        id: mov.id,
        tipo: tipo,
        concepto: concepto,
        monto: tipo === 'gasto' ? Math.abs(monto) : monto,
        operador: mov.usuarios?.nombre || 'N/A',
        fecha: mov.hora_entrada,
        descripcion: mov.descripcion,
        categoria: mov.categoria
      };
    });

    const ingresosTotal = ingresosTickets + ingresosExtra;
    const balance = ingresosTotal - gastosTotal;

    const gastosPorCategoria = movimientos
      .filter(m => m.tipo_vehiculo === 'gasto')
      .reduce((acc, gasto) => {
        const categoria = gasto.categoria || 'otros';
        acc[categoria] = (acc[categoria] || 0) + Math.abs(gasto.costo_total);
        return acc;
      }, {});

    const vehiculosActivos = movimientos.filter(m => 
      (m.tipo_vehiculo === 'auto' || m.tipo_vehiculo === 'moto') && 
      !m.hora_salida
    ).length;

    res.json({
      fecha: targetDate,
      ingresos: {
        tickets: Math.round(ingresosTickets * 100) / 100,
        extra: Math.round(ingresosExtra * 100) / 100,
        total: Math.round(ingresosTotal * 100) / 100
      },
      gastos: {
        total: Math.round(gastosTotal * 100) / 100,
        porCategoria: gastosPorCategoria
      },
      balance: Math.round(balance * 100) / 100,
      movimientos: movimientosDetallados,
      metricas: {
        vehiculos: movimientos.filter(m => m.tipo_vehiculo === 'auto' || m.tipo_vehiculo === 'moto').length,
        ingresosExtra: movimientos.filter(m => m.tipo_vehiculo === 'ingreso_extra').length,
        gastos: movimientos.filter(m => m.tipo_vehiculo === 'gasto').length,
        activos: vehiculosActivos
      }
    });

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==============================
// RUTAS DE ADMINISTRACIÓN
// ==============================

app.get("/api/tarifas", authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tarifas")
      .select("*")
      .order("tipo_vehiculo");

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/tarifas/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { precio_primera_hora, precio_hora_extra } = req.body;
    
    if (!precio_primera_hora || !precio_hora_extra) {
      return res.status(400).json({ error: "Todos los precios son requeridos" });
    }

    const { data, error } = await supabase
      .from("tarifas")
      .update({ 
        precio_primera_hora: parseFloat(precio_primera_hora),
        precio_hora_extra: parseFloat(precio_hora_extra)
      })
      .eq("id", req.params.id)
      .select();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/admin/usuarios", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("usuarios")
      .select("id, nombre, email, rol, created_at")
      .order("nombre");

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==============================
// Servir páginas
// ==============================
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/login.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public/dashboard.html")));
app.get("/registro", (req, res) => res.sendFile(path.join(__dirname, "public/registro.html")));
app.get("/tarifas", (req, res) => res.sendFile(path.join(__dirname, "public/tarifas.html")));
app.get("/ingresos", (req, res) => res.sendFile(path.join(__dirname, "public/ingresos.html")));
app.get("/gastos", (req, res) => res.sendFile(path.join(__dirname, "public/gastos.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));