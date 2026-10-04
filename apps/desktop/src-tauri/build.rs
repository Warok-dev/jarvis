// Récupère les valeurs publiques du projet Supabase depuis l'app web (même source de vérité).
fn main() {
    let env_file = "../../web/.env.production";
    println!("cargo:rerun-if-changed={env_file}");
    let content = std::fs::read_to_string(env_file).expect("apps/web/.env.production introuvable");
    for key in ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"] {
        let value = content
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{key}=")))
            .unwrap_or_else(|| panic!("{key} absent de {env_file}"))
            .trim();
        println!("cargo:rustc-env=JARVIS_{}={value}", key.trim_start_matches("VITE_"));
    }
    tauri_build::build()
}
