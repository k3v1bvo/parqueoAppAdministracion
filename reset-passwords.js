import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ ERROR: Faltan variables de entorno en .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function actualizarPasswords() {
  const usuarios = [
    { email: "admin@parqueo.com", password: "admin123" },
    { email: "juan@parqueo.com", password: "juan123" },
    { email: "maria@parqueo.com", password: "maria123" },
  ];

  for (const u of usuarios) {
    const hash = await bcrypt.hash(u.password, 10);

    const { error } = await supabase
      .from("usuarios")
      .update({ password: hash })   // ✅ solo password, nada más
      .eq("email", u.email);

    if (error) {
      console.log(`❌ Error con ${u.email}:`, error.message);
    } else {
      console.log(`✅ Contraseña actualizada para ${u.email}`);
    }
  }

  console.log("✅ Todo listo, prueba el login otra vez.");
  process.exit();
}

actualizarPasswords();
