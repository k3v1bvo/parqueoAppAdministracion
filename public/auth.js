// public/auth.js
// ================================================
// 🔐 ParqueoApp · Frontend
// Tablas: usuarios, tickets, ingresos_extra, egresos_admin,
//         planes, vehiculos, vehiculos_planes, configuracion, tarifas
// ================================================

const supa = window.supabase.createClient(
  window.__env.SUPABASE_URL,
  window.__env.SUPABASE_ANON
);

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

// ---------- Auth helpers ----------
const AuthUI = {
  async handleLogin(form) {
    const email = form.email.value.trim();
    const password = form.password.value;
    if(!email || !password){ toast('Completa email y contraseña', false); return; }
    const { error } = await supa.auth.signInWithPassword({ email, password });
    if(error){ toast(error.message || 'No se pudo iniciar sesión', false); return; }
    toast('Bienvenido');
    const { data: { user } } = await supa.auth.getUser();
    const role = user?.app_metadata?.role || '';
    location.href = role === 'admin' ? 'admin.html' : 'dashboard.html';
  },

  // Registro SIN nombre (usa el prefijo del email como nombre en public.usuarios)
  async handleRegister(form) {
    const email = form.email.value.trim();
    const password = form.password.value;
    if(!email || !password){ toast('Email y contraseña requeridos', false); return; }

    const { error } = await supa.auth.signUp({ email, password });
    if(error){ toast(error.message || 'No se pudo registrar', false); return; }

    try{
      const { data: userData } = await supa.auth.getUser();
      const uid = userData?.user?.id;
      if(uid){
        await supa.from('usuarios').upsert([{
          id: uid,
          nombre: email.split('@')[0],
          rol: 'empleado',
          email
        }]);
      }
    }catch(e){
      console.warn('usuarios.upsert falló:', e);
    }

    toast('Cuenta creada. Revisa tu correo si exige verificación.');
    location.href = 'login.html';
  },

  async sendReset(email){
    const { error } = await supa.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/login.html'
    });
    if(error) throw error;
    return true;
  },

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

// ---------- Utils ----------
const fmtDate   = (d)=> new Date(d).toLocaleString();
const cleanPlaca= (p)=> (p||'').toUpperCase().replace(/\s+/g,'');

// ---------- API ----------
const ParkingAPI = {

  // ===== RANGOS =====
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
  },

  // ===== CONFIGURACIÓN (saldo inicial extracto) =====
  async getSaldoInicial(){
    const { data, error } = await supa.from('configuracion')
      .select('valor').eq('clave','saldo_inicial').limit(1);
    if(error) throw error;
    const v = data?.[0]?.valor ?? '0';
    return Number(v||0);
  },
  async setSaldoInicial(monto){
    const v = String(Number(monto||0));
    const { error } = await supa.from('configuracion')
      .upsert([{ clave:'saldo_inicial', valor:v }], { onConflict:'clave' });
    if(error) throw error;
    return true;
  },

  // ===== TARIFAS (cache en memoria para cálculos) =====
  _tarifasCache: null,
  _tarifasAt: 0,
  async getTarifasMap() {
    if (!this._tarifasCache || (Date.now() - this._tarifasAt) > 30000) {
      const { data, error } = await supa.from('tarifas')
        .select('tipo_vehiculo,precio_primera_hora,precio_hora_extra,precio_minimo,umbral_minutos');
      if (error) throw error;
      this._tarifasCache = Object.fromEntries(
        (data || []).map(r => [ (r.tipo_vehiculo||'auto').toLowerCase(), r ])
      );
      this._tarifasAt = Date.now();
    }
    return this._tarifasCache;
  },

  // ===== TICKETS =====
  async crearTicket({ placa, tipoVehiculo, categoria = 'normal' }) {
    const { data: { user} } = await supa.auth.getUser();
    const operador_id = user?.id;
    placa = cleanPlaca(placa);

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

  async _calcularCostoPorReglas(ticket, cierreDate) {
    const entrada = new Date(ticket.hora_entrada);
    const salida  = cierreDate || new Date();

    const tf = await this.getTarifasMap();
    const tipo = (ticket.tipo_vehiculo || 'auto').toLowerCase();
    const r = tf[tipo] || tf['auto'] || {
      precio_primera_hora: 7, precio_hora_extra: 1, precio_minimo: 5, umbral_minutos: 45
    };

    const diffMin = Math.max(0, (salida - entrada) / 1000 / 60);

    if (diffMin <= Number(r.umbral_minutos || 45)) {
      return Number(r.precio_minimo || 5);
    }

    const extraHoras = Math.ceil((diffMin - 60) / 60);
    const total = Number(r.precio_primera_hora || 0) + (extraHoras > 0 ? extraHoras * Number(r.precio_hora_extra || 0) : 0);
    return total;
  },

  async _vehiculoIdPorPlaca(placa){
    placa = cleanPlaca(placa);
    let { data: v, error } = await supa.from('vehiculos').select('id').eq('placa', placa).limit(1);
    if (error) throw error;
    if (v?.length) return v[0].id;
    const ins = await supa.from('vehiculos').insert([{ placa }]).select('id').limit(1);
    if (ins.error) throw ins.error;
    return ins.data[0].id;
  },

  async _planActivoParaPlaca(placa, refDate = new Date()){
    const vehiculo_id = await this._vehiculoIdPorPlaca(placa);
    const nowISO = refDate.toISOString();
    const { data, error } = await supa.from('vehiculos_planes')
      .select('id,plan_id,fecha_inicio,fecha_fin,activo')
      .eq('vehiculo_id', vehiculo_id)
      .eq('activo', true);
    if (error) throw error;
    const activos = (data||[]).filter(r=>{
      const fi = r.fecha_inicio ? new Date(r.fecha_inicio) : null;
      const ff = r.fecha_fin    ? new Date(r.fecha_fin)    : null;
      const now = new Date(nowISO);
      const inRange = (!fi || fi <= now) && (!ff || now <= ff);
      return r.activo && inRange;
    });
    if(!activos.length) return null;

    const pid = activos[0].plan_id;
    const { data: pl, error: e2 } = await supa.from('planes')
      .select('id,nombre,precio,tipo,duracion_dias').eq('id', pid).limit(1);
    if (e2) throw e2;
    return pl?.[0] || null;
  },

  // Vista previa del total antes de cerrar
  async previewCierre({ placa }) {
    placa = cleanPlaca(placa);
    const now = new Date();

    const { data: tk, error } = await supa
      .from('tickets').select('*')
      .eq('placa_vehiculo', placa).eq('estado','ingresado').limit(1);
    if (error) throw error;
    if (!tk?.length) throw new Error('No hay ticket abierto para esa placa.');

    const t = tk[0];
    const plan = await this._planActivoParaPlaca(placa, now);

    if (plan) {
      return { usaPlan: true, total: 0, detalle: `Ticket con plan activo: ${plan.nombre} (${plan.tipo}). El cierre no cobra adicional.` };
    } else {
      const total = await this._calcularCostoPorReglas(t, now);
      return { usaPlan: false, total, detalle: `Cálculo por reglas desde ${fmtDate(t.hora_entrada)}.` };
    }
  },

  async cerrarTicket({ placa, tipo_pago = 'efectivo' }) {
    const { data: { user } } = await supa.auth.getUser();
    const uid = user?.id;
    placa = cleanPlaca(placa);
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

    let total = 0;
    const plan = await this._planActivoParaPlaca(placa, now);
    if(!plan){
      total = await this._calcularCostoPorReglas(t, now);
    }else{
      tipo_pago = 'plan';
    }

    const { error: upErr } = await supa.from('tickets').update({
      hora_salida: now.toISOString(),
      estado: 'pagado',
      costo_total: total,
      tipo_pago,
      descripcion: plan ? `Cerrado con plan: ${plan.nombre}` : t.descripcion
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

  // ===== ADMIN RESUMEN / EXTRACTO =====
  async adminResumenRango({ startISO, endISO }) {
    const [tks, ex, eg, ab, us] = await Promise.all([
      supa.from('tickets')
        .select('operador_id,costo_total,estado,hora_salida,tipo_pago,hora_entrada,placa_vehiculo,tipo_vehiculo')
        .gte('hora_salida', startISO).lte('hora_salida', endISO).eq('estado','pagado'),
      supa.from('ingresos_extra')
        .select('operador_id,monto,creado_at')
        .gte('creado_at', startISO).lte('creado_at', endISO),
      supa.from('egresos_admin')
        .select('id,concepto,monto,creado_at,admin_id')
        .gte('creado_at', startISO).lte('creado_at', endISO),
      supa.from('tickets').select('id').eq('estado','ingresado'),
      supa.from('usuarios').select('id,nombre')
    ]);

    const tickets = tks.data||[], extras=ex.data||[], egresos=eg.data||[];
    const abiertos = (ab.data||[]).length, usuarios = us.data||[];

    const sum = (arr,k)=> (arr||[]).reduce((a,b)=> a + Number(b[k]||0), 0);

    const ingresosTickets = sum(tickets,'costo_total');
    const ingresosExtra   = sum(extras,'monto');
    const egresosTotal    = sum(egresos,'monto');
    const neto            = ingresosTickets + ingresosExtra - egresosTotal;

    const name = (id)=> (usuarios.find(u=>u.id===id)?.nombre) || (id ? id.slice(0,6)+'…' : '—');
    const porOperador = {};
    tickets.forEach(t=>{
      const k = t.operador_id||'—';
      porOperador[k] ??= { operador_id:k, nombre:name(k), tickets:0, monto:0, extra:0 };
      porOperador[k].tickets += 1;
      porOperador[k].monto   += Number(t.costo_total||0);
    });
    extras.forEach(r=>{
      const k = r.operador_id||'—';
      porOperador[k] ??= { operador_id:k, nombre:name(k), tickets:0, monto:0, extra:0 };
      porOperador[k].extra   = (porOperador[k].extra||0) + Number(r.monto||0);
    });

    const recientes = tickets
      .slice().sort((a,b)=> new Date(b.hora_salida) - new Date(a.hora_salida))
      .slice(0,20);

    return {
      abiertos, ingresosTickets, ingresosExtra, egresos: egresosTotal, neto,
      porOperador: Object.values(porOperador).sort((a,b)=> (b.monto+(b.extra||0))-(a.monto+(a.extra||0))),
      recientes, extras, egresos
    };
  },

  async extractoBancario({ startISO, endISO }){
    const [tks, ex, eg] = await Promise.all([
      supa.from('tickets')
        .select('costo_total,hora_salida').eq('estado','pagado')
        .gte('hora_salida', startISO).lte('hora_salida', endISO),
      supa.from('ingresos_extra')
        .select('monto,creado_at').gte('creado_at', startISO).lte('creado_at', endISO),
      supa.from('egresos_admin')
        .select('monto,creado_at,concepto').gte('creado_at', startISO).lte('creado_at', endISO),
    ]);
    const tx = [];
    (tks.data||[]).forEach(r=> tx.push({ ts:r.hora_salida, tipo:'+tickets', concepto:'Pago ticket', monto:+(r.costo_total||0) }));
    (ex.data||[]).forEach(r=> tx.push({ ts:r.creado_at,  tipo:'+extra',   concepto:'Ingreso extra', monto:+(r.monto||0) }));
    (eg.data||[]).forEach(r=> tx.push({ ts:r.creado_at,  tipo:'-egreso',  concepto:r.concepto||'Egreso', monto:-Math.abs(+r.monto||0) }));

    tx.sort((a,b)=> new Date(a.ts) - new Date(b.ts));
    return tx;
  },

  async egresosPorMes(limit=12){
    const { data, error } = await supa.rpc('egresos_por_mes');
    if(error){
      const { data: rows } = await supa.from('egresos_admin').select('monto,creado_at');
      const agg = {};
      (rows||[]).forEach(r=>{
        const d = new Date(r.creado_at);
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        agg[key] = (agg[key]||0) + Number(r.monto||0);
      });
      const out = Object.entries(agg).map(([mes,total])=>({ mes, total }))
        .sort((a,b)=> a.mes<b.mes?-1:1).slice(-limit);
      return out;
    }
    return (data||[]).slice(-limit);
  },

  // ===== PLANES (CRUD + asignación) =====
  async catalogoPlanes() {
    const { data, error } = await supa
      .from('planes')
      .select('id, nombre, descripcion, precio, duracion_dias, tipo')
      .order('nombre', { ascending: true });
    if (error) throw error;
    return data || [];
  },
  async crearPlan({ nombre, descripcion, precio, duracion_dias=1, tipo='diario' }){
    const payload = { nombre, descripcion, precio:Number(precio||0), duracion_dias:Number(duracion_dias||1), tipo };
    const { error } = await supa.from('planes').insert([payload]);
    if(error) throw error;
    return true;
  },
  async actualizarPlan(id, { nombre, descripcion, precio, duracion_dias, tipo }){
    const payload = {};
    if(nombre!=null) payload.nombre = nombre;
    if(descripcion!=null) payload.descripcion = descripcion;
    if(precio!=null) payload.precio = Number(precio);
    if(duracion_dias!=null) payload.duracion_dias = Number(duracion_dias);
    if(tipo!=null) payload.tipo = tipo;
    const { error } = await supa.from('planes').update(payload).eq('id', id);
    if(error) throw error;
    return true;
  },
  async eliminarPlan(id){
    const { error } = await supa.from('planes').delete().eq('id', id);
    if(error) throw error;
    return true;
  },

  async _ensureVehiculo(placa) {
    const id = await this._vehiculoIdPorPlaca(placa);
    return id;
  },

  // Asignar plan cobrando y abriendo ticket de plan + ingreso del día
  async asignarPlanCobrando({ placa, plan_id, tipoVehiculo }){
    const p = cleanPlaca(placa);

    // 1) Si hay ticket abierto → cerrar y cobrar según reglas
    const { data: ab } = await supa.from('tickets')
      .select('*').eq('estado','ingresado').eq('placa_vehiculo', p).limit(1);
    if(ab?.length){
      await this.cerrarTicket({ placa:p, tipo_pago:'efectivo' });
    }

    // 2) Datos del plan
    const { data: planRow, error: pe } = await supa.from('planes')
      .select('id,nombre,precio,tipo,duracion_dias').eq('id', plan_id).limit(1);
    if(pe) throw pe;
    const plan = planRow?.[0];
    if(!plan) throw new Error('Plan no encontrado');

    // 3) Asignar plan (desactivar anteriores del mismo vehículo)
    const vehiculo_id = await this._ensureVehiculo(p);
    await supa.from('vehiculos_planes').update({ activo:false })
      .eq('vehiculo_id', vehiculo_id).eq('activo', true);

    const { error: insErr } = await supa.from('vehiculos_planes').insert([{
      vehiculo_id,
      plan_id,
      fecha_inicio: new Date().toISOString(),
      activo: true
    }]);
    if(insErr) throw insErr;

    // 4) Registrar el cobro del plan como INGRESO DEL DÍA
    const { data:{ user } } = await supa.auth.getUser();
    await supa.from('ingresos_extra').insert([{
      operador_id: user?.id || null,
      concepto: `Plan ${plan.nombre} · ${p}`,
      monto: Number(plan.precio||0)
    }]);

    // 5) Abrir ticket marcado como plan
    await this.abrirTicketConPlan({ placa:p, tipoVehiculo, plan_id });

    toast('Plan asignado · ingreso registrado · ticket (plan) abierto');
    notify('Plan asignado', `Placa ${p} · ${plan.nombre} · ${Number(plan.precio||0).toFixed(2)} Bs`);
    return true;
  },

  async listarAsignaciones() {
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

  async abrirTicketConPlan({ placa, tipoVehiculo, plan_id }){
    const { data: { user} } = await supa.auth.getUser();
    const operador_id = user?.id;
    const placaN = cleanPlaca(placa);

    const { data: ab, error: e1 } = await supa
      .from('tickets').select('id').eq('placa_vehiculo', placaN).eq('estado','ingresado').limit(1);
    if (e1) throw e1;
    if (ab?.length) throw new Error('Esa placa ya tiene un ticket abierto.');

    const { error } = await supa.from('tickets').insert([{
      placa_vehiculo: placaN,
      tipo_vehiculo: tipoVehiculo,
      operador_id,
      categoria: 'plan',
      tipo_pago: 'plan'
    }]);
    if(error) throw error;

    toast('Ticket (plan) abierto');
    notify('Ticket (plan) abierto', `Placa ${placaN}`);
    return true;
  },

  // ===== TARIFAS (CRUD UI) =====
  async listarTarifas() {
    const { data, error } = await supa.from('tarifas')
      .select('id,tipo_vehiculo,precio_primera_hora,precio_hora_extra,precio_minimo,umbral_minutos')
      .order('tipo_vehiculo');
    if (error) throw error;
    return data || [];
  },
  async actualizarTarifa(id, primera, extra, minimo, umbral) {
    const { error } = await supa.from('tarifas').update({
      precio_primera_hora: Number(primera),
      precio_hora_extra:   Number(extra),
      precio_minimo:       Number(minimo),
      umbral_minutos:      Number(umbral)
    }).eq('id', id);
    if (error) throw error;
    this._tarifasCache = null; // invalida cache
    return true;
  }
};

// Exponer
window.AuthUI = AuthUI;
window.ParkingAPI = ParkingAPI;
window.supa = supa;
window.toast = toast;
window.notify = notify;
