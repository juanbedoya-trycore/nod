// Lista "nunca desde el reloj" (SPEC §6.4). Si un patrón coincide con el comando (Bash) o con el
// `tool_input` serializado (resto de tools), `wok=false`: el reloj solo puede denegar y el mod rechaza
// cualquier `allow` de ese nonce (`reject:"forbidden"`), aunque la firma sea válida.
//
// Los patrones se evalúan sobre un segmento de comando (hasta `;`, `&`, `|` o salto de línea) y erran a
// favor de marcar: un falso positivo solo obliga a aprobar en el terminal; un falso negativo dejaría
// aprobar desde la muñeca algo destructivo.
//
// Lista por defecto (DEFAULT_FORBIDDEN):
//   rm-rf           rm con recursivo (-r, -R, --recursive) y forzado (-f, --force), en cualquier orden y
//                   combinación de flags (-rf, -fr, -r -f, -Rf, --recursive --force, flags tras la ruta)
//   git-push-force  git push con --force, -f (también combinado: -fu), --force-with-lease o un refspec +rama
//   kubectl         kubectl apply | delete
//   terraform       terraform apply | destroy
//   helm            helm upgrade | install | uninstall
//   publish         npm | pnpm | yarn publish
//   vercel-prod     vercel ... --prod
//   fly-deploy      fly | flyctl deploy
//   gcloud-deploy   gcloud ... deploy (app, run, functions...)
//
// Configuración (config.ts / parsePermConfig): ORBIT_FORBIDDEN (array JSON de regex) sustituye la lista,
// ORBIT_FORBIDDEN_ADD (array JSON de regex) la amplía. Una regex inválida desactiva la retención entera
// (sin lista fiable, el reloj no debe poder aprobar nada).

export interface ForbiddenRule {
  name: string;
  re: RegExp;
}

/** Fin de segmento de comando: lo que hay después de `;`, `&`, `|` o `\n` es otro comando. */
const SEG = "[^;&|\\n]*";
/** Inicio de palabra de comando (también tras una ruta: /bin/rm, o tras `(`, `` ` ``, `$(`). */
const START = "(?:^|[\\s;&|(`/\"'])";

export const DEFAULT_FORBIDDEN: readonly ForbiddenRule[] = [
  {
    name: "rm-rf",
    re: new RegExp(
      `${START}rm(?=\\s)(?=${SEG}\\s-(?:-recursive\\b|[A-Za-z]*[rR]))(?=${SEG}\\s-(?:-force\\b|[A-Za-z]*f))`,
    ),
  },
  {
    name: "git-push-force",
    re: new RegExp(
      `${START}git\\s${SEG}\\bpush\\b(?=${SEG}\\s(?:--force(?:-with-lease)?(?:=\\S*)?|-[A-Za-z]*f[A-Za-z]*|\\+\\S+)(?:\\s|$|["'\\\\]))`,
    ),
  },
  { name: "kubectl", re: new RegExp(`${START}kubectl\\s${SEG}\\b(?:apply|delete)\\b`) },
  { name: "terraform", re: new RegExp(`${START}terraform\\s${SEG}\\b(?:apply|destroy)\\b`) },
  { name: "helm", re: new RegExp(`${START}helm\\s${SEG}\\b(?:upgrade|install|uninstall)\\b`) },
  { name: "publish", re: new RegExp(`${START}(?:npm|pnpm|yarn)\\s${SEG}\\bpublish\\b`) },
  { name: "vercel-prod", re: new RegExp(`${START}vercel\\b${SEG}\\s--prod\\b`) },
  { name: "fly-deploy", re: new RegExp(`${START}(?:fly|flyctl)\\s${SEG}\\bdeploy\\b`) },
  { name: "gcloud-deploy", re: new RegExp(`${START}gcloud\\s${SEG}\\bdeploy\\b`) },
];

/** Texto sobre el que se evalúa la lista: el comando de Bash, o el `tool_input` en JSON compacto. */
export function forbiddenSubject(tool: string, input: unknown): string {
  if (tool === "Bash" && input !== null && typeof input === "object") {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === "string") return command;
  }
  try {
    return JSON.stringify(input ?? {}) ?? "";
  } catch {
    // No serializable: no se puede comprobar, así que se trata como prohibido.
    return "\u0000unserializable";
  }
}

/**
 * Forma "desenmascarada" de un comando: quita el quoting de shell que no cambia qué se ejecuta, para
 * que la lista no se salte con `\rm`, `"rm"`, `'rm'`, `r\m`, `rm${IFS}-rf`, `$(echo rm)` o con las
 * opciones largas abreviadas de GNU (`--recur`, `--forc`). Se evalúa además del texto original: solo
 * puede añadir coincidencias (errar a favor de marcar).
 */
export function unquoteShell(subject: string): string {
  let s = subject;
  // $(echo x) y `echo x` -> x
  s = s.replace(/\$\(\s*(?:echo|printf)\s+([^()]*)\)/g, " $1 ").replace(/`\s*(?:echo|printf)\s+([^`]*)`/g, " $1 ");
  // $IFS, ${IFS}, ${IFS:0:1}... -> espacio
  s = s.replace(/\$\{IFS[^}]*\}|\$IFS\b/g, " ");
  // continuación de línea, escapes y comillas
  s = s.replace(/\\\n/g, "").replace(/\\/g, "").replace(/["']/g, "");
  // opciones largas abreviadas (GNU acepta cualquier prefijo no ambiguo)
  s = s.replace(/(\s)--r(?:e(?:c(?:u(?:r(?:s(?:i(?:ve?)?)?)?)?)?)?)?(?=[\s=]|$)/g, "$1--recursive");
  s = s.replace(/(\s)--fo(?:r(?:c(?:e)?)?)?(?=[\s=]|$)/g, "$1--force");
  return s;
}

/** Nombre de la primera regla que coincide (con el texto original o desenmascarado), o undefined. */
export function matchForbidden(subject: string, rules: readonly ForbiddenRule[]): string | undefined {
  if (subject === "\u0000unserializable") return "unserializable";
  const variants = [subject];
  const plain = unquoteShell(subject);
  if (plain !== subject) variants.push(plain);
  for (const rule of rules) {
    for (const v of variants) {
      rule.re.lastIndex = 0;
      if (rule.re.test(v)) return rule.name;
    }
  }
  return undefined;
}

/** `wok` de §6.4: true si el reloj puede aprobar. */
export function watchOk(tool: string, input: unknown, rules: readonly ForbiddenRule[]): boolean {
  return matchForbidden(forbiddenSubject(tool, input), rules) === undefined;
}

export type RulesResult = { ok: true; rules: ForbiddenRule[] } | { ok: false; error: string };

/** Compila una lista de regex en texto (de la configuración). */
export function compileRules(patterns: readonly string[], prefix: string): RulesResult {
  const rules: ForbiddenRule[] = [];
  for (const [i, p] of patterns.entries()) {
    try {
      rules.push({ name: `${prefix}${i}`, re: new RegExp(p) });
    } catch (err) {
      return { ok: false, error: `regex inválida ${JSON.stringify(p)}: ${String(err)}` };
    }
  }
  return { ok: true, rules };
}
