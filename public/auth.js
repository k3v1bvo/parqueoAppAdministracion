/** auth.js - ParqueoApp (tickets + extras + egresos + planes/suscripciones) */
const supa = window.supabase.createClient(
  window.__env.SUPABASE_URL,
  window.__env.SUPABASE_ANON
);

// ──────────────────────────────────────────────────────────────
// Utils
// ──────────────────────────────────────────────────────────────
const qs = (s) => document.querySelector(s);
function toast(msg, ok=true){
  const box = qs("#toast"); if(!box) return alert(msg);
  box.className = ok ? "toast ok" : "toast error";
  box.textContent = msg; box.style.opacity = "1";
  setTimeout(()=> box.style.opacity = "0", 2200);
}
function normalizePlate(v){ return (v||"").toString().toUpperCase().replace(/\s+/g,"").trim(); }
function startOfTodayISO(){ const d=new Date(); d.setHours(0,0,0,0); return d.toISOString(); }
function monthKey(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }

// ──────────────────────────────────────────────────────────────
async function getSession(){ const {data} = await supa.auth.getSession(); return data.session??null; }
async function requireAuth(){ const s = await getSession(); if(!s) location.replace("login.html"); return s; }
async function alreadyLoggedRedirect(){ const s = await getSession(); if(s) location.replace("dashboard.html"); }
async function logout(){ await supa.auth.signOut(); location.replace("login.html"); }
async function isAdmin(){
  const { data:{user} } = await supa.auth.getUser();
  const role = user?.app_metadata?.role || user?.user_metadata?.role;
  return role === "admin";
}
async function requireAdmin(){ await requireAuth(); if(!(await isAdmin())){ toast("No autorizado (solo admin).", false); location.replace("dashboard.html"); }}

// crea/actualiza fila en public.usuarios
async function ensureUsuarioRow(){
  const { data:{ user } } = await supa.auth.getUser(); if(!user) return;
  const nombre = (user.user_metadata?.nombre) || user.email.split("@")[0];
  const { error } = await supa.from("usuarios").upsert(
    { id:user.id, nombre, rol:"empleado", email:user.email },
    { onConflict:"id" }
  );
  if(error) console.warn("usuarios upsert:", error);
}
async function handleLogin(form){
  const email=form.email.value.trim(), password=form.password.value.trim();
  try{
    const {error}=await supa.auth.signInWithPassword({email,password});
    if(error) throw error;
    await ensureUsuarioRow(); location.replace("dashboard.html");
  }catch(e){ toast(e.message||String(e), false); }
}
async function handleRegister(form){
  const email=form.email.value.trim(), password=form.password.value.trim();
  try{
    const {error}=await supa.auth.signUp({email,password});
    if(error) throw error;
    toast("Cuenta creada. Revisa tu correo para confirmar.");
  }catch(e){ toast(e.message||String(e), false); }
}

// ──────────────────────────────────────────────────────────────
// Tickets / Vehículos
// ──────────────────────────────────────────────────────────────
async function ensureVehiculo(placaRaw){
  const placa = normalizePlate(placaRaw);
  if(!placa) throw new Error("Ingresa una placa");
  const r = await supa.from("vehiculos").select("id").eq("placa", placa).maybeSingle();
  if(r.error) throw r.error;
  if(!r.data){
    const ins = await supa.from("vehiculos").insert({placa}).select("id").single();
    if(ins.error) throw ins.error; return ins.data.id;
  }
  return r.data.id;
}

async function abrirTicket({placa, tipoVehiculo}){
  const PLACA = normalizePlate(placa);
  if(!PLACA) throw new Error("Ingresa una placa");
  if(!["auto","moto","bicicleta"].includes(tipoVehiculo)){
    throw new Error("Tipo de vehículo inválido");
  }
  await ensureVehiculo(PLACA);
  const { data:{user} } = await supa.auth.getUser();
  const abierto = await supa.from("tickets")
    .select("id").eq("placa_vehiculo", PLACA).eq("estado","ingresado").maybeSingle();
  if(abierto.error) throw abierto.error;
  if(abierto.data) throw new Error("Ya existe un ticket abierto para esa placa");

  const ins = await supa.from("tickets").insert({
    placa_vehiculo: PLACA,
    tipo_vehiculo: tipoVehiculo,
    estado: "ingresado",
    operador_id: user.id,
    tipo_pago: "por_hora"
  }).select("id").single();

  if(ins.error) throw ins.error;
  return ins.data.id;
}

async function ticketAbiertoPorPlaca(placa){
  const P = normalizePlate(placa);
  const r = await supa.from("tickets").select("*")
    .eq("placa_vehiculo", P).eq("estado","ingresado")
    .order("hora_entrada",{ascending:false}).limit(1).maybeSingle();
  if(r.error) throw r.error; return r.data||null;
}

async function tarifaPorTipo(tipo){
  const r = await supa.from("tarifas").select("precio_primera_hora, precio_hora_extra")
    .eq("tipo_vehiculo", tipo).single();
  if(r.error) throw r.error; return r.data;
}

function calcularMonto(entradaISO, ahoraISO, primera, extra, desc=0){
  const a=new Date(entradaISO), b=ahoraISO?new Date(ahoraISO):new Date();
  const mins=Math.max(0, Math.round((b-a)/60000));
  const horas=Math.ceil(mins/60);
  let tot = horas<=1 ? Number(primera) : Number(primera)+(horas-1)*Number(extra);
  tot = tot - Number(desc||0);
  return tot<0 ? 0 : Number(tot.toFixed(2));
}

// ──────────────────────────────────────────────────────────────
// Planes / Suscripciones
// ──────────────────────────────────────────────────────────────
/** Devuelve el plan activo para una placa (o null) */
async function planActivoPorPlaca(placaRaw){
  const placa = normalizePlate(placaRaw);
  const veh = await supa.from("vehiculos").select("id").eq("placa", placa).maybeSingle();
  if(veh.error) throw veh.error;
  if(!veh.data) return null;

  const vp = await supa.from("vehiculos_planes")
    .select("id, plan_id, fecha_inicio, fecha_fin, activo")
    .eq("vehiculo_id", veh.data.id).eq("activo", true)
    .maybeSingle();
  if(vp.error && vp.error.code!=='PGRST116') throw vp.error; // not found safe
  if(!vp.data) return null;

  // validar fecha fin
  const ahora = new Date();
  if(vp.data.fecha_fin && new Date(vp.data.fecha_fin) < ahora){ return null; }

  const pl = await supa.from("planes").select("*").eq("id", vp.data.plan_id).maybeSingle();
  if(pl.error) throw pl.error;
  if(!pl.data) return null;

  return { placa, vehiculo_id: veh.data.id, asignacion_id: vp.data.id, ...pl.data };
}

/** Cerrar ticket aplicando plan si existe; si no, cobra por hora */
async function cerrarTicketPorPlaca(placa, formaPago="efectivo"){
  const t = await ticketAbiertoPorPlaca(placa);
  if(!t) throw new Error("No hay ticket abierto para esa placa");

  // ¿Tiene plan activo?
  const plan = await planActivoPorPlaca(placa);

  let costo = 0, tipoPago = formaPago, descripcion = null;
  const now = new Date().toISOString();

  if(plan){
    // Política: mensual = 0; medio/diario = precio fijo del plan
    if(plan.tipo === 'mensual'){ costo = 0; }
    else { costo = Number(plan.precio); }
    tipoPago = "plan";
    descripcion = `Plan: ${plan.nombre}`;
  } else {
    const tar = await tarifaPorTipo(t.tipo_vehiculo);
    costo = calcularMonto(t.hora_entrada, now, tar.precio_primera_hora, tar.precio_hora_extra, t.descuento);
  }

  const upd = await supa.from("tickets").update({
    hora_salida: now,
    costo_total: costo,
    estado: "pagado",
    tipo_pago: tipoPago,
    descripcion
  }).eq("id", t.id);
  if(upd.error) throw upd.error;

  return { id:t.id, costo, formaPago: tipoPago, plan: plan?.nombre || null };
}

// ──────────────────────────────────────────────────────────────
// Tarifas
// ──────────────────────────────────────────────────────────────
async function listarTarifas(){ const r=await supa.from("tarifas").select("*").order("tipo_vehiculo"); if(r.error) throw r.error; return r.data||[]; }
async function actualizarTarifa(tipo, primera, extra){
  const r = await supa.from("tarifas").update({
    precio_primera_hora:Number(primera), precio_hora_extra:Number(extra)
  }).eq("tipo_vehiculo", tipo);
  if(r.error) throw r.error; return true;
}

// ──────────────────────────────────────────────────────────────
// Ingresos extra + Egresos admin
// ──────────────────────────────────────────────────────────────
async function crearIngresoExtra({ concepto, monto }){
  const { data:{ user } } = await supa.auth.getUser();
  const r = await supa.from("ingresos_extra").insert({
    operador_id: user.id, concepto, monto: Number(monto)
  }).select("id, creado_at").single();
  if(r.error) throw r.error; return r.data;
}
async function listarIngresosExtra({ desdeISO, hastaISO, operadorId=null }){
  let q = supa.from("ingresos_extra")
    .select("id, operador_id, concepto, monto, creado_at")
    .gte("creado_at", desdeISO).lte("creado_at", hastaISO)
    .order("creado_at",{ascending:false});
  if(operadorId) q = q.eq("operador_id", operadorId);
  const r = await q; if(r.error) throw r.error; return r.data||[];
}
function todayRange(){
  const s=new Date(); s.setHours(0,0,0,0);
  const e=new Date(); e.setHours(23,59,59,999);
  return {desdeISO:s.toISOString(), hastaISO:e.toISOString()};
}
async function crearEgresoAdmin({ concepto, monto }){
  const { data:{ user } } = await supa.auth.getUser();
  const r = await supa.from("egresos_admin").insert({
    admin_id: user.id, concepto, monto: Number(monto)
  }).select("id, creado_at").single();
  if(r.error) throw r.error; return r.data;
}
async function listarEgresosAdmin({ desdeISO, hastaISO, adminId=null }){
  let q = supa.from("egresos_admin")
    .select("id, admin_id, concepto, monto, creado_at")
    .gte("creado_at", desdeISO).lte("creado_at", hastaISO)
    .order("creado_at",{ascending:false});
  if(adminId) q = q.eq("admin_id", adminId);
  const r = await q; if(r.error) throw r.error; return r.data||[];
}

// ──────────────────────────────────────────────────────────────
// Dashboard / Resúmenes (igual que tenías, recortado en lo justo)
// ──────────────────────────────────────────────────────────────
async function statsHoy(){
  const desde = startOfTodayISO();

  const abiertos=await supa.from("tickets").select("id",{count:"exact",head:true}).eq("estado","ingresado");
  const hoy=await supa.from("tickets").select("id",{count:"exact",head:true}).gte("hora_entrada",desde);
  const cerrados=await supa.from("tickets").select("costo_total,tipo_pago").eq("estado","pagado").gte("hora_salida",desde);
  if(cerrados.error) throw cerrados.error;
  const recTickets=(cerrados.data||[]).reduce((a,b)=>a+Number(b.costo_total||0),0);

  const extras = await listarIngresosExtra({desdeISO:desde, hastaISO:new Date().toISOString()});
  const recExtras = extras.reduce((a,b)=>a+Number(b.monto||0),0);

  return {
    abiertosCount:abiertos.count??0,
    ticketsHoy:hoy.count??0,
    recaudadoTickets:Number(recTickets),
    recaudadoExtras:Number(recExtras),
    recaudadoTotal:Number(recTickets + recExtras)
  };
}

async function listarUltimosTickets(limit=20){
  const r=await supa.from("tickets")
    .select("id, placa_vehiculo, tipo_vehiculo, estado, hora_entrada, hora_salida, costo_total, tipo_pago, operador_id, descripcion")
    .order("hora_entrada",{ascending:false}).limit(limit);
  if(r.error) throw r.error; return r.data||[];
}

// Rango + resumen admin (igual al previo)
function rango(periodo){
  const now=new Date(); const end=new Date(now); const start=new Date(now);
  if(periodo==="daily"){ start.setHours(0,0,0,0); end.setHours(23,59,59,999); }
  else if(periodo==="weekly"){ const d=now.getDay(); const diff=(d+6)%7; start.setDate(now.getDate()-diff); start.setHours(0,0,0,0); end.setHours(23,59,59,999); }
  else if(periodo==="monthly"){ start.setDate(1); start.setHours(0,0,0,0); end.setMonth(end.getMonth()+1,0); end.setHours(23,59,59,999); }
  else if(periodo==="yearly"){ start.setMonth(0,1); start.setHours(0,0,0,0); end.setMonth(11,31); end.setHours(23,59,59,999); }
  else if(periodo==="alltime"){ start.setTime(0); }
  return { startISO:start.toISOString(), endISO:end.toISOString() };
}

async function ticketsEntre(desdeISO, hastaISO){
  const r = await supa.from("tickets")
    .select("id, operador_id, estado, hora_entrada, hora_salida, costo_total, tipo_pago")
    .gte("hora_entrada", desdeISO).lte("hora_entrada", hastaISO);
  if(r.error) throw r.error; return r.data||[];
}
async function extrasEntre(desdeISO, hastaISO){
  return await listarIngresosExtra({desdeISO, hastaISO});
}
async function egresosEntre(desdeISO, hastaISO){
  return await listarEgresosAdmin({desdeISO, hastaISO});
}

async function adminResumenRango(startISO, endISO, empId=""){
  const [tks, exs, egr] = await Promise.all([
    ticketsEntre(startISO,endISO),
    extrasEntre(startISO,endISO),
    egresosEntre(startISO,endISO)
  ]);

  const T = empId ? tks.filter(d=>d.operador_id===empId) : tks;
  const E = empId ? exs.filter(d=>d.operador_id===empId) : exs;
  const G = empId ? egr.filter(d=>d.admin_id===empId)   : egr;

  let tickets_total=0, tickets_cerrados=0, tickets_abiertos=0;
  const porDiaTickets=new Map(), porDiaExtras=new Map(), porDiaEgresos=new Map();
  const porEmpleadoTickets=new Map(), porEmpleadoExtras=new Map();
  const pagos = { efectivo:0, qr:0 };
  const porDiaPagoEfectivo = new Map(), porDiaPagoQR = new Map();

  T.forEach(t=>{
    if(t.estado==='pagado'){ 
      const amt = Number(t.costo_total||0);
      tickets_total += amt; tickets_cerrados++;
      if(t.tipo_pago==='qr'){ pagos.qr += amt; const k=new Date(t.hora_entrada).toISOString().slice(0,10); porDiaPagoQR.set(k,(porDiaPagoQR.get(k)||0)+amt); }
      else { pagos.efectivo += amt; const k=new Date(t.hora_entrada).toISOString().slice(0,10); porDiaPagoEfectivo.set(k,(porDiaPagoEfectivo.get(k)||0)+amt); }
    }
    if(t.estado==='ingresado') tickets_abiertos++;
    const key = new Date(t.hora_entrada).toISOString().slice(0,10);
    porDiaTickets.set(key, (porDiaTickets.get(key)||0) + Number(t.costo_total||0));
    if(t.operador_id) porEmpleadoTickets.set(t.operador_id, (porEmpleadoTickets.get(t.operador_id)||0) + Number(t.costo_total||0));
  });

  let extras_total=0;
  E.forEach(x=>{
    extras_total += Number(x.monto||0);
    const key = new Date(x.creado_at).toISOString().slice(0,10);
    porDiaExtras.set(key, (porDiaExtras.get(key)||0) + Number(x.monto||0));
    if(x.operador_id) porEmpleadoExtras.set(x.operador_id, (porEmpleadoExtras.get(x.operador_id)||0) + Number(x.monto||0));
  });

  let egresos_total=0;
  G.forEach(g=>{
    egresos_total += Number(g.monto||0);
    const key = new Date(g.creado_at).toISOString().slice(0,10);
    porDiaEgresos.set(key, (porDiaEgresos.get(key)||0) + Number(g.monto||0));
  });

  const allDays = new Set([
    ...porDiaTickets.keys(), ...porDiaExtras.keys(), ...porDiaEgresos.keys(),
    ...porDiaPagoEfectivo.keys(), ...porDiaPagoQR.keys()
  ]);
  const porDiaNeto = new Map();
  allDays.forEach(k=>{
    const tt = Number(porDiaTickets.get(k)||0);
    const ex = Number(porDiaExtras.get(k)||0);
    const eg = Number(porDiaEgresos.get(k)||0);
    porDiaNeto.set(k, tt + ex - eg);
  });

  const empleados = new Map();
  const allEmp = new Set([...porEmpleadoTickets.keys(), ...porEmpleadoExtras.keys()]);
  allEmp.forEach(id=>{
    empleados.set(id, {
      tickets: Number(porEmpleadoTickets.get(id)||0),
      extras: Number(porEmpleadoExtras.get(id)||0),
      total:  Number(porEmpleadoTickets.get(id)||0) + Number(porEmpleadoExtras.get(id)||0),
    });
  });

  return {
    rango:{startISO, endISO},
    tickets_total: Number(tickets_total.toFixed(2)),
    tickets_cerrados,
    tickets_abiertos,
    porDiaTickets,
    extras_total: Number(extras_total.toFixed(2)),
    porDiaExtras,
    egresos_total: Number(egresos_total.toFixed(2)),
    porDiaEgresos,
    pagos: { 
      efectivo: Number(pagos.efectivo.toFixed(2)),
      qr:       Number(pagos.qr.toFixed(2)),
      porDia: { efectivo: porDiaPagoEfectivo, qr: porDiaPagoQR }
    },
    neto_total: Number((tickets_total + extras_total - egresos_total).toFixed(2)),
    porDiaNeto,
    porEmpleadoCombined: empleados
  };
}

// Acumulado histórico + histórico mensual
async function acumuladoGlobal(){
  const t = await supa.from("tickets").select("costo_total").eq("estado","pagado");
  if(t.error) throw t.error;
  const totalTickets = (t.data||[]).reduce((a,b)=>a+Number(b.costo_total||0),0);

  const e = await supa.from("ingresos_extra").select("monto");
  if(e.error) throw e.error;
  const totalExtras = (e.data||[]).reduce((a,b)=>a+Number(b.monto||0),0);

  const g = await supa.from("egresos_admin").select("monto");
  if(g.error) throw g.error;
  const totalEgresos = (g.data||[]).reduce((a,b)=>a+Number(b.monto||0),0);

  return {
    totalTickets: Number(totalTickets.toFixed(2)),
    totalExtras: Number(totalExtras.toFixed(2)),
    totalEgresos: Number(totalEgresos.toFixed(2)),
    neto: Number((totalTickets + totalExtras - totalEgresos).toFixed(2))
  };
}
async function historicoMensual(ultimoN=12){
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth()-(ultimoN-1), 1, 0,0,0,0);
  const startISO = start.toISOString();
  const [tks, exs, egr] = await Promise.all([
    supa.from("tickets").select("costo_total, estado, hora_salida").eq("estado","pagado").gte("hora_salida", startISO),
    supa.from("ingresos_extra").select("monto, creado_at").gte("creado_at", startISO),
    supa.from("egresos_admin").select("monto, creado_at").gte("creado_at", startISO)
  ]);
  if(tks.error) throw tks.error; if(exs.error) throw exs.error; if(egr.error) throw egr.error;
  const months=[]; for(let i=0;i<ultimoN;i++){ const d=new Date(start.getFullYear(), start.getMonth()+i, 1); months.push(monthKey(d)); }
  const mapT=new Map(months.map(m=>[m,0])); const mapE=new Map(months.map(m=>[m,0])); const mapG=new Map(months.map(m=>[m,0]));
  (tks.data||[]).forEach(r=>{ const d=r.hora_salida?new Date(r.hora_salida):null; if(!d) return; const k=monthKey(d); if(mapT.has(k)) mapT.set(k,mapT.get(k)+Number(r.costo_total||0));});
  (exs.data||[]).forEach(r=>{ const d=r.creado_at?new Date(r.creado_at):null; if(!d) return; const k=monthKey(d); if(mapE.has(k)) mapE.set(k,mapE.get(k)+Number(r.monto||0));});
  (egr.data||[]).forEach(r=>{ const d=r.creado_at?new Date(r.creado_at):null; if(!d) return; const k=monthKey(d); if(mapG.has(k)) mapG.set(k,mapG.get(k)+Number(r.monto||0));});
  const labels=months;
  const tickets=labels.map(m=>Number(mapT.get(m)||0));
  const extras=labels.map(m=>Number(mapE.get(m)||0));
  const egresos=labels.map(m=>Number(mapG.get(m)||0));
  const neto=labels.map((_,i)=> Number((tickets[i]+extras[i]-egresos[i]).toFixed(2)));
  return { labels, tickets, extras, egresos, neto };
}

// Exponer API
window.AuthUI = { handleLogin, handleRegister, logout, requireAuth, alreadyLoggedRedirect, requireAdmin };
window.ParkingAPI = {
  abrirTicket, cerrarTicketPorPlaca,
  listarTarifas, actualizarTarifa,
  listarUltimosTickets, statsHoy,
  isAdmin, calcularMonto,
  rango, adminResumenRango,
  crearIngresoExtra, listarIngresosExtra, todayRange,
  crearEgresoAdmin, listarEgresosAdmin,
  acumuladoGlobal, historicoMensual,
  planActivoPorPlaca
};

// navbar email + toggle móvil
(async ()=>{
  const s=await getSession(); const email=s?.user?.email||""; const el=qs("#currentUser");
  if(el){ const admin=await isAdmin(); el.textContent=email+(admin?" (Admin)":""); }
  const t=qs('#menuToggle'), links=qs('#navLinks');
  if(t && links){ t.addEventListener('click', ()=> links.classList.toggle('open')); }
})();
