import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// Configuración de paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuración de entorno
dotenv.config();

// Crear aplicación Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Configuración de Supabase
console.log("🔄 Iniciando servidor...");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ ERROR: Faltan variables de entorno");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const JWT_SECRET = process.env.JWT_SECRET || 'parqueo_secret_2024';

console.log("✅ Supabase configurado correctamente");

// ==============================
// MIDDLEWARE DE AUTENTICACIÓN
// ==============================

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token de acceso requerido' });
    }

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

// ==============================
// RUTAS DE AUTENTICACIÓN MEJORADAS
// ==============================

app.post("/api/auth/login", async (req, res) => {
  console.log("🔐 SOLICITUD LOGIN:", { email: req.body.email, password: '***' });
  
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña son requeridos" });
    }

    // Buscar usuario
    const { data: usuario, error } = await supabase
      .from("usuarios")
      .select("*")
      .eq("email", email.toLowerCase().trim())
      .single();

    if (error || !usuario) {
      console.log("❌ USUARIO NO ENCONTRADO:", email);
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    console.log("✅ USUARIO ENCONTRADO:", usuario.email);
    
    // Verificar si el hash es válido
    const isValidBcryptHash = usuario.password && 
      (usuario.password.startsWith('$2a$') || 
       usuario.password.startsWith('$2b$') || 
       usuario.password.startsWith('$2y$'));
    
    console.log("🔍 ESTRUCTURA HASH VÁLIDA:", isValidBcryptHash);
    
    if (!isValidBcryptHash) {
      console.log("❌ HASH INVALIDO EN BD");
      return res.status(500).json({ error: "Error en configuración de contraseñas" });
    }

    // Verificar contraseña
    const passwordValid = await bcrypt.compare(password, usuario.password);
    console.log("🔍 RESULTADO COMPARACIÓN:", passwordValid);
    
    if (!passwordValid) {
      console.log("❌ CONTRASEÑA INCORRECTA");
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    console.log("✅ CONTRASEÑA VÁLIDA");

    // Crear token JWT
    const token = jwt.sign(
      { 
        userId: usuario.id, 
        email: usuario.email,
        rol: usuario.rol 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Calcular expiración
    const expiraEn = new Date();
    expiraEn.setHours(expiraEn.getHours() + 24);

    // Guardar sesión
    const { error: sessionError } = await supabase
      .from("sesiones")
      .insert([{
        usuario_id: usuario.id,
        token: token,
        expira_en: expiraEn.toISOString()
      }]);

    if (sessionError) {
      console.log("❌ ERROR SESIÓN:", sessionError.message);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    console.log("🎉 LOGIN EXITOSO:", usuario.nombre);

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
    console.log("💥 ERROR GENERAL:", error.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// RUTAS QUE USAN authenticateToken
app.get("/api/auth/me", authenticateToken, (req, res) => {
  res.json({ user: req.user });
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

// ==============================
// RUTAS DE TICKETS (MANTENIDAS)
// ==============================

app.get("/api/tickets/activos", authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tickets")
      .select("*, usuarios!operador_id(nombre, email)")
      .is("hora_salida", null)
      .order("hora_entrada", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

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
      .select("*, usuarios!operador_id(nombre, email)");

    if (error) throw error;
    res.json({ success: true, data });
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
      .select("*, usuarios!operador_id(nombre, email)");

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
      .select("*, usuarios!operador_id(nombre, email)");

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
      .select("*, usuarios!operador_id(nombre, email)")
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
      .select("*, usuarios!operador_id(nombre, email)");

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
      .select("*, usuarios!operador_id(nombre, email)")
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
// RUTAS DE REPORTES
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

app.get("/api/resumen/financiero", authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const { data: movimientos, error } = await supabase
      .from("tickets")
      .select("*, usuarios!operador_id(nombre, email)")
      .gte("hora_entrada", today)
      .lt("hora_entrada", `${today}T23:59:59`)
      .order("hora_entrada", { ascending: false });

    if (error) throw error;

    const ingresosTickets = movimientos
      .filter(m => (m.tipo_vehiculo === 'auto' || m.tipo_vehiculo === 'moto') && m.costo_total > 0)
      .reduce((sum, m) => sum + (m.costo_total || 0), 0);

    const ingresosExtra = movimientos
      .filter(m => m.tipo_vehiculo === 'ingreso_extra')
      .reduce((sum, m) => sum + (m.costo_total || 0), 0);

    const gastosTotal = movimientos
      .filter(m => m.tipo_vehiculo === 'gasto')
      .reduce((sum, m) => sum + Math.abs(m.costo_total || 0), 0);

    const balance = (ingresosTickets + ingresosExtra) - gastosTotal;

    res.json({
      fecha: today,
      ingresos: {
        tickets: Math.round(ingresosTickets * 100) / 100,
        extra: Math.round(ingresosExtra * 100) / 100,
        total: Math.round((ingresosTickets + ingresosExtra) * 100) / 100
      },
      gastos: Math.round(gastosTotal * 100) / 100,
      balance: Math.round(balance * 100) / 100
    });

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==============================
// RUTAS PARA SERVIR ARCHIVOS HTML
// ==============================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/registro", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "registro.html"));
});

app.get("/tarifas", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "tarifas.html"));
});

app.get("/ingresos", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "ingresos.html"));
});

app.get("/gastos", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "gastos.html"));
});

// Manejo de errores para rutas no encontradas
app.use((req, res) => {
  console.log(`❌ Ruta no encontrada: ${req.method} ${req.url}`);
  res.status(404).json({ 
    error: "Ruta no encontrada",
    method: req.method,
    url: req.url 
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📧 Credenciales de prueba:`);
  console.log(`   👑 Admin: admin@parqueo.com / admin123`);
  console.log(`   👨‍💼 Empleado: juan@parqueo.com / juan123`);
  console.log(`   👩‍💼 Empleado: maria@parqueo.com / maria123`);
});