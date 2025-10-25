/** auth.js - lógica central del sistema Parqueo (con extras y tipo de pago) */
const supa = window.supabase.createClient(
  window.__env.SUPABASE_URL,
  window.__env.SUPABASE_ANON
);

// ------------- UTILIDADES -------------
function qs(sel) { return document.querySelector(sel); }
function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }

function toast(msg, ok = true) {
  const box = qs("#toast");
  if (!box) return alert(msg);
  box.className = ok ? "toast ok" : "toast error";
  box.textContent = msg;
  box.style.opacity = "1";
  setTimeout(() => { box.style.opacity = "0"; }, 2000);
}

// Normaliza placa: quita espacios, mayúsculas
function normalizePlate(v) {
  return (v || "").toString().toUpperCase().replace(/\s+/g, "").trim();
}

// ------------- AUTENTICACIÓN -------------
async function getSession() {
  const { data } = await supa.auth.getSession();
  return data.session ?? null;
}
async function requireAuth() {
  const s = await getSession();
  if (!s) location.replace("login.html");
  return s;
}
async function alreadyLoggedRedirect() {
  const s = await getSession();
  if (s) location.replace("dashboard.html");
}
async function logout() {
  await supa.auth.signOut();
  location.replace("login.html");
}
async function handleLogin(form) {
  const email = form.email.value.trim();
  const password = form.password.value.trim();
  try {
    const { error } = await supa.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await ensureUsuarioRow();
    location.replace("dashboard.html");
  } catch (e) { toast(e.message || String(e), false); }
}
async function handleRegister(form) {
  const email = form.email.value.trim();
  const password = form.password.value.trim();
  try {
    const { error } = await supa.auth.signUp({ email, password });
    if (error) throw error;
    toast("Cuenta creada. Revisa tu correo para confirmar.");
  } catch (e) { toast(e.message || String(e), false); }
}

// ------------- USUARIO / ADMIN -------------
async function ensureUsuarioRow() {
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return;
  const nombre = user.email.split("@")[0];
  const { error } = await supa.from("usuarios").upsert(
    { id: user.id, nombre, rol: "empleado", email: user.email },
    { onConflict: "id" }
  );
  if (error) console.warn("⚠️ usuarios upsert:", error);
}
async function isAdmin() {
  const { data: { user } } = await supa.auth.getUser();
  const role = user?.app_metadata?.role || user?.user_metadata?.role;
  return role === "admin";
}
async function requireAdmin() {
  await requireAuth();
  const admin = await isAdmin();
  if (!admin) location.replace("dashboard.html");
}

// ------------- VEHÍCULOS / TICKETS -------------
async function ensureVehiculo(placaRaw) {
  const placa = normalizePlate(placaRaw);
  if (!placa) throw new Error("Ingresa una placa");
  const r = await supa.from("vehiculos").select("id").eq("placa", placa).maybeSingle();
  if (r.error) throw r.error;
  if (!r.data) {
    const ins = await supa.from("vehiculos").insert({ placa }).select("id").single();
    if (ins.error) throw ins.error;
    return ins.data.id;
  }
  return r.data.id;
}

async function abrirTicket({ placa, tipoVehiculo }) {
  const PLACA = normalizePlate(placa);
  if (!PLACA) throw new Error("Ingresa una placa");

  await ensureVehiculo(PLACA);

  const { data: { user } } = await supa.auth.getUser();
  const abierto = await supa.from("tickets")
    .select("id").eq("placa_vehiculo", PLACA).eq("estado", "ingresado").maybeSingle();
  if (abierto.error) throw abierto.error;
  if (abierto.data) throw new Error("Ya existe un ticket abierto para esa placa");

  const ins = await supa.from("tickets").insert({
    placa_vehiculo: PLACA,
    tipo_vehiculo: tipoVehiculo,
    estado: "ingresado",
    operador_id: user.id,
  }).select("id").single();

  if (ins.error) throw ins.error;
  return ins.data.id;
}

async function ticketAbiertoPorPlaca(placa) {
  const PLACA = normalizePlate(placa);
  const r = await supa.from("tickets")
    .select("*").eq("placa_vehiculo", PLACA).eq("estado", "ingresado")
    .order("hora_entrada", { ascending: false }).limit(1).maybeSingle();
  if (r.error) throw r.error;
  return r.data || null;
}

async function tarifaPorTipo(tipo) {
  const r = await supa.from("tarifas")
    .select("precio_primera_hora, precio_hora_extra").eq("tipo_vehiculo", tipo).single();
  if (r.error) throw r.error;
  return r.data;
}

function calcularMonto(entradaISO, ahoraISO, primera, extra, desc = 0) {
  const a = new Date(entradaISO);
  const b = ahoraISO ? new Date(ahoraISO) : new Date();
  const mins = Math.max(0, Math.round((b - a) / 60000));
  const horas = Math.ceil(mins / 60);
  let tot = horas <= 1 ? Number(primera) : Number(primera) + (horas - 1) * Number(extra);
  tot = tot - Number(desc || 0);
  return tot < 0 ? 0 : Number(tot.toFixed(2));
}

/** Cierra ticket estableciendo tipo de pago ('efectivo' por defecto o 'qr') */
async function cerrarTicketPorPlaca(placa, tipoPago = 'efectivo') {
  const t = await ticketAbiertoPorPlaca(placa);
  if (!t) throw new Error("No hay ticket abierto para esa placa");

  const tar = await tarifaPorTipo(t.tipo_vehiculo);
  const now = new Date().toISOString();
  const costo = calcularMonto(t.hora_entrada, now, tar.precio_primera_hora, tar.precio_hora_extra, t.descuento);

  const upd = await supa.from("tickets").update({
    hora_salida: now,
    costo_total: costo,
    estado: "pagado",
    tipo_pago: tipoPago
  }).eq("id", t.id);
  if (upd.error) throw upd.error;

  return { id: t.id, costo, tipo_pago: tipoPago };
}

// ------------- TARIFAS -------------
async function listarTarifas() {
  const r = await supa.from("tarifas").select("*").order("tipo_vehiculo");
  if (r.error) throw r.error;
  return r.data || [];
}
async function actualizarTarifa(tipo, primera, extra) {
  const r = await supa.from("tarifas")
    .update({ precio_primera_hora: Number(primera), precio_hora_extra: Number(extra) })
    .eq("tipo_vehiculo", tipo);
  if (r.error) throw r.error;
  return true;
}

// ------------- ESTADÍSTICAS / DASHBOARD -------------
function startOfTodayISO() { const d = new Date(); d.setHours(0,0,0,0); return d.toISOString(); }
async function statsHoy() {
  const desde = startOfTodayISO();
  const abiertos = await supa.from("tickets").select("id",{count:"exact",head:true}).eq("estado","ingresado");
  const hoy = await supa.from("tickets").select("id",{count:"exact",head:true}).gte("hora_entrada",desde);
  const cerrados = await supa.from("tickets").select("costo_total").eq("estado","pagado").gte("hora_salida",desde);
  if (cerrados.error) throw cerrados.error;
  const rec = (cerrados.data||[]).reduce((a,b)=>a+Number(b.costo_total||0),0);
  return { abiertosCount: abiertos.count??0, ticketsHoy: hoy.count??0, recaudado: Number(rec) };
}
async function listarUltimosTickets(limit=20){
  const r = await supa.from("tickets")
    .select("id, placa_vehiculo, tipo_vehiculo, estado, hora_entrada, hora_salida, costo_total, operador_id, tipo_pago")
    .order("hora_entrada",{ascending:false}).limit(limit);
  if(r.error) throw r.error; return r.data||[];
}

// --- Admin: rangos y agregados ---
function rangeStart(period){
  const d = new Date();
  if(period==='day'){ d.setHours(0,0,0,0); }
  else if(period==='week'){ const wd=(d.getDay()+6)%7; d.setDate(d.getDate()-wd); d.setHours(0,0,0,0); }
  else if(period==='month'){ d.setDate(1); d.setHours(0,0,0,0); }
  else if(period==='year'){ d.setMonth(0,1); d.setHours(0,0,0,0); }
  return d.toISOString();
}
async function usuariosMapByIds(ids){
  if(!ids.length) return {};
  const r = await supa.from('usuarios').select('id,nombre,email').in('id', ids);
  if(r.error) throw r.error;
  return (r.data||[]).reduce((acc,u)=>{ acc[u.id]=u; return acc; },{});
}
function keyByDay(iso){
  const d=new Date(iso);
  const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
async function adminStats(period='day'){
  const desde = rangeStart(period);
  const r = await supa.from('tickets')
    .select('id, operador_id, estado, hora_entrada, hora_salida, costo_total')
    .gte('hora_entrada', desde)
    .order('hora_entrada', { ascending: true });
  if(r.error) throw r.error;
  const rows = r.data || [];

  const totalTickets = rows.length;
  const recaudado = rows
    .filter(t => t.estado === 'pagado')
    .reduce((a,b)=>a+Number(b.costo_total||0),0);
  const abiertos = rows.filter(t => t.estado === 'ingresado').length;

  const porEmpleado = {};
  rows.forEach(t=>{
    const k = t.operador_id || 'desconocido';
    porEmpleado[k] = porEmpleado[k] || { tickets:0, recaudado:0 };
    porEmpleado[k].tickets += 1;
    if (t.estado === 'pagado') porEmpleado[k].recaudado += Number(t.costo_total||0);
  });
  const ids = Object.keys(porEmpleado).filter(x=>x!=='desconocido');
  const users = await usuariosMapByIds(ids);
  const detalleEmpleados = Object.keys(porEmpleado).map(id=>({
    id,
    nombre: users[id]?.nombre || '—',
    email: users[id]?.email || '—',
    tickets: porEmpleado[id].tickets,
    recaudado: Number(porEmpleado[id].recaudado.toFixed(2)),
  })).sort((a,b)=> b.recaudado - a.recaudado);

  const serie = {};
  rows.forEach(t=>{
    const k = keyByDay(t.hora_salida || t.hora_entrada);
    serie[k] = serie[k] || { recaudado:0, tickets:0 };
    if (t.estado === 'pagado') serie[k].recaudado += Number(t.costo_total||0);
    serie[k].tickets += 1;
  });
  const labels = Object.keys(serie).sort();
  const dataRecaudado = labels.map(l => Number(serie[l].recaudado.toFixed(2)));
  const dataTickets   = labels.map(l => serie[l].tickets);

  return {
    kpis: { totalTickets, recaudado: Number(recaudado.toFixed(2)), abiertos },
    detalleEmpleados,
    chart: { labels, dataRecaudado, dataTickets }
  };
}

// ------------- INGRESOS EXTRA -------------
function startOfToday(){ const d = new Date(); d.setHours(0,0,0,0); return d; }
function iso(d){ return d.toISOString(); }

/** Crea ingreso extra (baño, lavado, etc.) asociado al operador logueado */
async function agregarIngresoExtra({ concepto, monto }) {
  if (!concepto) throw new Error("Ingresa un concepto");
  const val = Number(monto);
  if (!(val > 0)) throw new Error("Monto inválido");

  const { data: { user } } = await supa.auth.getUser();
  const ins = await supa.from('ingresos_extra').insert({
    operador_id: user.id, concepto, monto: val
  }).select('id').single();
  if (ins.error) throw ins.error;
  return ins.data.id;
}

/** Lista ingresos extra desde una fecha (por defecto, hoy) */
async function listarIngresosExtra(desdeISO = iso(startOfToday())) {
  const r = await supa.from('ingresos_extra')
    .select('id, concepto, monto, creado_at, operador_id')
    .gte('creado_at', desdeISO)
    .order('creado_at', { ascending: false });
  if (r.error) throw r.error;
  return r.data || [];
}

/** Totales de extras por operador (desde fecha) */
async function totalesExtrasPorOperador(desdeISO = iso(startOfToday())) {
  const r = await supa.from('ingresos_extra')
    .select('operador_id, monto')
    .gte('creado_at', desdeISO);
  if (r.error) throw r.error;
  const acc = {};
  (r.data||[]).forEach(row => {
    acc[row.operador_id] = (acc[row.operador_id] || 0) + Number(row.monto || 0);
  });
  return acc; // mapa { operador_id: total }
}

// ------------- EXPORTAR -------------
window.AuthUI = { handleLogin, handleRegister, logout, requireAuth, alreadyLoggedRedirect, requireAdmin };
window.ParkingAPI = {
  abrirTicket, cerrarTicketPorPlaca,
  listarTarifas, actualizarTarifa,
  listarUltimosTickets, statsHoy,
  isAdmin, calcularMonto,
  adminStats,
  agregarIngresoExtra, listarIngresosExtra, totalesExtrasPorOperador
};

// Navbar: muestra email y (Admin)
(async () => {
  const s = await getSession();
  const email = s?.user?.email || "";
  const el = qs("#currentUser");
  if (el) { const admin = await isAdmin(); el.textContent = email + (admin ? " (Admin)" : ""); }
})();
