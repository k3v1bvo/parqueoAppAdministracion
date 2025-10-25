// Pega tus credenciales reales de Supabase aquí (ANON key, NO service_role).
// Supabase → Project Settings → API → Project URL y anon public (Public API Key).

window.__env = {
  SUPABASE_URL: "https://nhqdxwmdhvwzsfngrwrg.supabase.co", // <-- reemplaza
  SUPABASE_ANON: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ocWR4d21kaHZ3enNmbmdyd3JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc0MjQ1NDEsImV4cCI6MjA3MzAwMDU0MX0._lXqgCGD7c48zzO6HO7C6u5-QhXnWP04EpFVPS45qKI"          // <-- reemplaza
};

// Chequeo amable para evitar errores de configuración
(function validateEnv() {
  const url  = window.__env && window.__env.SUPABASE_URL;
  const anon = window.__env && window.__env.SUPABASE_ANON;

  const isUrlOk  = typeof url === "string" && /^https:\/\/.+\.supabase\.co$/.test(url);
  const isAnonOk = typeof anon === "string" && anon.length > 40 && !/service/i.test(anon);

  if (!isUrlOk || !isAnonOk) {
    const msg = "Configura SUPABASE_URL y SUPABASE_ANON en public/config.js (ANON key, no service_role)";
    console.error("❌", msg);

    const box = document.getElementById("toast");
    if (box) {
      box.className = "toast error";
      box.textContent = msg;
      box.style.opacity = "1";
    } else {
      // Evita que pase desapercibido en páginas sin #toast
      alert(msg);
    }
  } else {
    console.log("✅ Supabase config OK");
  }
})();
