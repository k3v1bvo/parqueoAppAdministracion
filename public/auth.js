// public/auth.js
// ================================================
// 🔐 ParqueoApp · Frontend (adaptado a tu schema)
// ================================================

const supa = window.supabase.createClient(
  window.__env.SUPABASE_URL,
  window.__env.SUPABASE_ANON
);

// ---------- Auth helpers ----------
const AuthUI = {
  async requireLogin() {
    const { data: { session } } = await supa.auth.getSession();
    if (!session) location.href = 'login.html';
    setCurrentUser(session);
  },
  async requireAdmin() {
    const { data: { session } } = await supa.auth.getSession();
    if (!session) location.href = 'login.html';
    if ((session.user?.app_metadata?.role || '') !== 'admin') {
      location.href = 'dashboard.html';
      return;
    }
    setCurrentUser(session);
  },
  async logout() {
    await supa.auth.signOut();
    location.href = 'login.html';
  }
};

function setCurrentUser(session){
  const el = document.getElementById('currentUser');
  if(!el) return;
  const email = session?.user?.email || '';
  const role = session?.user?.app_metadata?.role || '';
  el.textContent = `${email} ${role ? '(' + role.charAt(0).toUpperCase() + role.slice(1) + ')' : ''}`;
}

// ---------- Toast + Notificación ----------
function toast(msg, ok = true) {
  const t = document.getElementById('toast');
  if (!t) { if(!ok) console.error(msg); alert(msg); return; }
  t.textContent = msg;
  t.className = 'toast ' + (ok ? 'ok' : 'err');
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2200);
}
async function notify(title, body){
  try{
    if(!('Notification' in window)) return;
    if(Notification.permission === 'granted'){
      new Notification(title, { body });
    }else if(Notification.permission !== 'denied'){
      const perm = await Notification.requestPermission();
      if(perm === 'granted') new Notification(title, { body });
    }
  }catch(_){}
}

// ---------- API ----------
const ParkingAPI = {

  // helpers
  _placa(p) { return (p || '').toUpperCase().replace(/\s+/g, ''); },

  // ===== TICKETS =====
  async crearTicket({ placa, tipoVehiculo, categoria = 'normal' }) {
    const { data: { user} } = await supa.auth.getUser();
    const operador_id = user?.id;
    placa = this._placa(placa);

    const { data: ab, error: e1 } = await supa
      .from('tickets').select('id')
      .eq('placa_vehiculo', placa).eq('estado', 'ingresado').limit(1);
    if (e1) throw e1;
    if (ab?.length) throw new Error('Esa placa ya tiene un ticket abierto.');

    const { error } = await supa.from('tickets').insert([{
      placa_vehiculo: placa,
      tipo_vehiculo: tipoVehiculo,
      operador_id,
      categoria
    }]);
    if (error) throw error;

    toast('Ticket abierto');
    notify('Ticket abierto', `Placa ${placa} (${tipoVehiculo})`);
    return true;
  },

  _calcularCosto(ticket, cierreDate) {
    const entrada = new Date(ticket.hora_entrada);
    const horaEntrada = entrada.getHours();
    const categoria = (ticket.categoria || 'normal').toLowerCase();
    // Noche 20:00–07:59 → 12 Bs
    if (horaEntrada >= 20 || horaEntrada < 8) return 12;
    // Día 08:00–19:59
    if (categoria === 'frecuente') return 12;
    if (categoria === 'normal')    return 15;
    // Fallback por horas (7 + 1)
    const ms = (cierreDate - entrada);
    const horas = Math.max(1, Math.ceil(ms / (1000 * 60 * 60)));
    return 7 + (horas - 1) * 1;
  },

  async cerrarTicket({ placa, tipo_pago = 'efectivo' }) {
    const { data: { user } } = await supa.auth.getUser();
    const uid = user?.id;
    placa = this._placa(placa);
    const now = new Date();

    const { data: tk, error } = await supa
      .from('tickets').select('*')
      .eq('placa_vehiculo', placa).eq('estado','ingresado').limit(1);
    if (error) throw error;
    if (!tk?.length) throw new Error('No se encontró ticket abierto para esa placa.');

    const t = tk[0];
    const { data: { session } } = await supa.auth.getSession();
    const isAdmin = (session?.user?.app_metadata?.role||'') === 'admin';
    if(!isAdmin && t.operador_id !== uid){
      throw new Error('Solo el admin puede cerrar tickets de otros operadores.');
    }

    const total = this._calcularCosto(t, now);
    const { error: upErr } = await supa.from('tickets').update({
      hora_salida: now.toISOString(),
      estado: 'pagado',
      costo_total: total,
      tipo_pago
    }).eq('id', t.id);
    if (upErr) throw upErr;

    toast(`Ticket cerrado · ${total.toFixed(2)} Bs`);
    notify('Ticket cerrado', `Placa ${placa} · ${total.toFixed(2)} Bs`);
    return total;
  },

  async cerrarTicketManual(ticketId) {
    const { error } = await supa.from('tickets').update({
      hora_salida: new Date().toISOString(),
      estado: 'pagado',
      costo_total: 0,
      descripcion: 'Cerrado manualmente por admin'
    }).eq('id', ticketId);
    if (error) throw error;
    toast('Ticket cerrado manualmente');
    notify('Cierre manual', 'Ticket cerrado por administrador');
    return true;
  },

  async placasAbiertas() {
    const { data, error } = await supa
      .from('tickets').select('placa_vehiculo').eq('estado', 'ingresado');
    if (error) throw error;
    const set = new Set((data || []).map(d => d.placa_vehiculo));
    return Array.from(set).sort();
  },

  async listarAbiertos() {
    const { data, error } = await supa
      .from('tickets')
      .select('id, placa_vehiculo, tipo_vehiculo, hora_entrada, categoria, operador_id')
      .eq('estado', 'ingresado')
      .order('hora_entrada', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  async historialPropio({ startISO, endISO }) {
    const { data: { user } } = await supa.auth.getUser();
    const uid = user?.id;
    const { data, error } = await supa.from('tickets')
      .select('placa_vehiculo, tipo_vehiculo, estado, hora_entrada, hora_salida, costo_total')
      .eq('operador_id', uid)
      .gte('hora_entrada', startISO).lte('hora_entrada', endISO)
      .order('hora_entrada', { ascending:false });
    if (error) throw error;
    return data || [];
  },

  // ===== ADMIN: resumen por rango =====
  async adminResumenRango({ startISO, endISO }) {
    // Tickets pagados dentro del rango (por hora_salida)
    const { data: tks, error: e1 } = await supa.from('tickets')
      .select('operador_id,costo_total,estado,hora_salida')
      .gte('hora_salida', startISO).lte('hora_salida', endISO)
      .eq('estado','pagado');
    if (e1) throw e1;

    // Ingresos extra
    const { data: ex, error: e2 } = await supa.from('ingresos_extra')
      .select('operador_id,monto,creado_at')
      .gte('creado_at', startISO).lte('creado_at', endISO);
    if (e2) throw e2;

    // Egresos admin
    const { data: eg, error: e3 } = await supa.from('egresos_admin')
      .select('monto,creado_at,admin_id')
      .gte('creado_at', startISO).lte('creado_at', endISO);
    if (e3) throw e3;

    // Abiertos actuales (para KPI)
    const { data: ab } = await supa.from('tickets').select('id').eq('estado','ingresado');

    // Usuarios para mapear operador_id -> nombre
    const { data: us } = await supa.from('usuarios').select('id,nombre');

    const nameMap = new Map((us||[]).map(u=>[u.id, u.nombre||u.id.slice(0,6)]));

    const sum = (arr, k)=> (arr||[]).reduce((a,b)=> a + Number(b[k]||0), 0);

    const ingresosTickets = sum(tks,'costo_total');
    const ingresosExtra   = sum(ex,'monto');
    const egresos         = sum(eg,'monto');
    const neto            = ingresosTickets + ingresosExtra - egresos;

    // Por operador
    const porOperador = {};
    (tks||[]).forEach(r=>{
      const k = r.operador_id || '—';
      porOperador[k] ??= { operador_id:k, nombre:nameMap.get(k)||'—', tickets:0, monto:0 };
      porOperador[k].tickets += 1;
      porOperador[k].monto   += Number(r.costo_total||0);
    });
    (ex||[]).forEach(r=>{
      const k = r.operador_id || '—';
      porOperador[k] ??= { operador_id:k, nombre:nameMap.get(k)||'—', tickets:0, monto:0, extra:0 };
      porOperador[k].extra   = (porOperador[k].extra||0) + Number(r.monto||0);
    });

    // Recientes (últimos 15 pagados por hora_salida)
    const { data: recientes } = await supa.from('tickets')
      .select('placa_vehiculo,tipo_vehiculo,hora_entrada,hora_salida,costo_total')
      .eq('estado','pagado')
      .order('hora_salida',{ascending:false})
      .limit(15);

    return {
      abiertos: (ab||[]).length,
      ingresosTickets,
      ingresosExtra,
      egresos,
      neto,
      porOperador: Object.values(porOperador).sort((a,b)=> (b.monto||0)-(a.monto||0)),
      recientes: recientes||[]
    };
  },

  // ===== PLANES =====
  async catalogoPlanes() {
    const { data, error } = await supa
      .from('planes')
      .select('id, nombre, descripcion, precio, duracion_dias, tipo')
      .order('nombre', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  async _ensureVehiculo(placa) {
    placa = this._placa(placa);
    let { data: v } = await supa.from('vehiculos').select('id').eq('placa', placa).limit(1);
    if (v?.length) return v[0].id;
    const { data, error } = await supa.from('vehiculos').insert([{ placa }]).select('id').limit(1);
    if (error) throw error;
    return data[0].id;
  },

  async asignarPlanAPlaca({ placa, plan_id, fecha_inicio = null, fecha_fin = null }) {
    const vehiculo_id = await this._ensureVehiculo(placa);

    await supa.from('vehiculos_planes')
      .update({ activo: false })
      .eq('vehiculo_id', vehiculo_id)
      .eq('activo', true);

    const payload = {
      vehiculo_id,
      plan_id,
      fecha_inicio: fecha_inicio || new Date().toISOString(),
      fecha_fin,
      activo: true
    };
    const { error } = await supa.from('vehiculos_planes').insert([payload]);
    if (error) throw error;

    toast('Plan asignado a la placa');
    notify('Plan asignado', `Placa ${this._placa(placa)}`);
    return true;
  },

  async listarAsignaciones() {
    // NO usamos creado_at (tu tabla no lo tiene). Ordenamos por fecha_inicio desc.
    const { data: asign, error: e1 } = await supa.from('vehiculos_planes')
      .select('vehiculo_id, plan_id, fecha_inicio, fecha_fin, activo, id')
      .order('fecha_inicio', { ascending:false });
    if (e1) throw e1;

    const { data: vehs, error: e2 } = await supa.from('vehiculos').select('id, placa');
    if (e2) throw e2;

    const { data: pls, error: e3 } = await supa.from('planes')
      .select('id, nombre, precio, tipo, duracion_dias');
    if (e3) throw e3;

    const mapV = new Map((vehs||[]).map(v => [v.id, v.placa]));
    const mapP = new Map((pls||[]).map(p => [p.id, p]));

    return (asign||[]).map(a => ({
      id: a.id,
      placa: mapV.get(a.vehiculo_id) || '—',
      plan: mapP.get(a.plan_id)?.nombre || '—',
      precio: mapP.get(a.plan_id)?.precio ?? null,
      tipo: mapP.get(a.plan_id)?.tipo || '—',
      duracion_dias: mapP.get(a.plan_id)?.duracion_dias ?? null,
      fecha_inicio: a.fecha_inicio,
      fecha_fin: a.fecha_fin,
      activo: !!a.activo
    }));
  },

  // ===== Tarifas =====
  async listarTarifas() {
    const { data, error } = await supa.from('tarifas')
      .select('id,tipo_vehiculo,precio_primera_hora,precio_hora_extra')
      .order('tipo_vehiculo');
    if (error) throw error;
    return data || [];
  },
  async actualizarTarifa(id, primera, extra) {
    const { error } = await supa.from('tarifas').update({
      precio_primera_hora: Number(primera),
      precio_hora_extra: Number(extra)
    }).eq('id', id);
    if (error) throw error;
    return true;
  },

  // ===== Rangos =====
  rango(preset) {
    const now = new Date();
    let start = new Date(now), end = new Date(now);
    if (preset === 'daily') {
      start.setHours(0,0,0,0); end.setHours(23,59,59,999);
    } else if (preset === 'weekly') {
      const d = new Date(now); const day = (d.getDay()+6)%7;
      start = new Date(d); start.setDate(d.getDate()-day); start.setHours(0,0,0,0);
      end = new Date(start); end.setDate(start.getDate()+6); end.setHours(23,59,59,999);
    } else if (preset === 'monthly') {
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0,0,0,0);
      end = new Date(now.getFullYear(), now.getMonth()+1, 0, 23,59,59,999);
    } else if (preset === 'yearly') {
      start = new Date(now.getFullYear(), 0, 1, 0,0,0,0);
      end = new Date(now.getFullYear(), 11, 31, 23,59,59,999);
    } else {
      start = new Date(2000,0,1); end = new Date(2099,11,31,23,59,59,999);
    }
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  }
};

// Exponer
window.AuthUI = AuthUI;
window.ParkingAPI = ParkingAPI;
window.supa = supa;
window.toast = toast;
window.notify = notify;
