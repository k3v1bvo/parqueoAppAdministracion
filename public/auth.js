// public/auth.js
// ================================================
// 🔐 ParqueoApp · Lógica de Frontend (Producción)
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

// ---------- Toast ----------
function toast(msg, ok = true) {
  const t = document.getElementById('toast');
  if (!t) { if(!ok) console.error(msg); alert(msg); return; }
  t.textContent = msg;
  t.className = 'toast ' + (ok ? 'ok' : 'err');
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2200);
}

// ---------- Notificaciones nativas ----------
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

// ---------- API principal ----------
const ParkingAPI = {

  _placa(p) { return (p || '').toUpperCase().replace(/\s+/g, ''); },

  async crearTicket({ placa, tipoVehiculo, categoria = 'normal' }) {
    const { data: { user} } = await supa.auth.getUser();
    const operador_id = user?.id;
    placa = this._placa(placa);

    const { data: ab, error: e1 } = await supa.from('tickets')
      .select('id').eq('placa_vehiculo', placa).eq('estado', 'ingresado').limit(1);
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
    if (horaEntrada >= 20 || horaEntrada < 8) return 12;     // Noche
    if (categoria === 'frecuente') return 12;                 // Día frecuente
    if (categoria === 'normal')    return 15;                 // Día normal
    const ms = (cierreDate - entrada);
    const horas = Math.max(1, Math.ceil(ms / (1000 * 60 * 60)));
    return 7 + (horas - 1) * 1;                               // Fallback por horas
  },

  async cerrarTicket({ placa, tipo_pago = 'efectivo' }) {
    const { data: { user } } = await supa.auth.getUser();
    const uid = user?.id;
    placa = this._placa(placa);
    const now = new Date();

    const { data: tk, error } = await supa.from('tickets')
      .select('*').eq('placa_vehiculo', placa).eq('estado', 'ingresado').limit(1);
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
    const { data, error } = await supa.from('tickets')
      .select('placa_vehiculo').eq('estado', 'ingresado');
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

  async crearPlan({ placa, tipoVehiculo, nombrePlan, precio }) {
    const { data: { user } } = await supa.auth.getUser();
    const operador_id = user?.id;
    placa = this._placa(placa);
    const { error } = await supa.from('vehiculos_planes').insert([{
      placa,
      tipo_vehiculo: tipoVehiculo,
      plan_nombre: nombrePlan,
      precio,
      operador_id
    }]);
    if (error) throw error;
    return true;
  },
  async listarPlanes() {
    const { data, error } = await supa.from('vehiculos_planes')
      .select('*').order('creado_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

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
    } else { // alltime
      start = new Date(2000,0,1); end = new Date(2099,11,31,23,59,59,999);
    }
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  }
};

window.AuthUI = AuthUI;
window.ParkingAPI = ParkingAPI;
window.supa = supa;
window.toast = toast;
window.notify = notify;
