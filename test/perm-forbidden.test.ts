// SPEC §6.4: lista "nunca desde el reloj".
import { describe, expect, it } from "vitest";
import { DEFAULT_FORBIDDEN, compileRules, forbiddenSubject, matchForbidden, unquoteShell, watchOk } from "../src/core/perm/forbidden.js";

const m = (cmd: string) => matchForbidden(cmd, DEFAULT_FORBIDDEN);

describe("lista por defecto", () => {
  it.each([
    ["rm -rf build", "rm-rf"],
    ["rm -fr build", "rm-rf"],
    ["rm -Rf /", "rm-rf"],
    ["rm -r -f build", "rm-rf"],
    ["rm -f -r build", "rm-rf"],
    ["rm -v -r -f build", "rm-rf"],
    ["rm --recursive --force build", "rm-rf"],
    ["rm --force -r build", "rm-rf"],
    ["rm build -rf", "rm-rf"],
    ["sudo rm -rf /var", "rm-rf"],
    ["/bin/rm -rf x", "rm-rf"],
    ["cd x && rm -rf y", "rm-rf"],
    ["find . | xargs rm -rf", "rm-rf"],
    ["git push --force", "git-push-force"],
    ["git push -f origin main", "git-push-force"],
    ["git push origin main --force-with-lease", "git-push-force"],
    ["git push --force-with-lease=main:abc origin main", "git-push-force"],
    ["git push -fu origin main", "git-push-force"],
    ["git push origin +main", "git-push-force"],
    ["git -C repo push --force", "git-push-force"],
    ["kubectl apply -f k8s/", "kubectl"],
    ["kubectl -n prod delete pod x", "kubectl"],
    ["terraform apply -auto-approve", "terraform"],
    ["terraform destroy", "terraform"],
    ["helm upgrade --install app ./chart", "helm"],
    ["helm install app ./chart", "helm"],
    ["helm uninstall app", "helm"],
    ["npm publish", "publish"],
    ["pnpm publish --access public", "publish"],
    ["vercel --prod", "vercel-prod"],
    ["vercel deploy --prod", "vercel-prod"],
    ["fly deploy", "fly-deploy"],
    ["flyctl deploy --remote-only", "fly-deploy"],
    ["gcloud app deploy", "gcloud-deploy"],
    ["gcloud run deploy svc --image x", "gcloud-deploy"],
  ])("marca %s", (cmd, rule) => {
    expect(m(cmd)).toBe(rule);
  });

  it.each([
    ["rm file.txt"],
    ["rm -r dir"],
    ["rm -f file"],
    ["ls -rf"],
    ["git push origin main"],
    ["git push -u origin main"],
    ["git status --force"],
    ["kubectl get pods"],
    ["terraform plan"],
    ["helm list"],
    ["npm install"],
    ["vercel"],
    ["fly status"],
    ["gcloud auth login"],
    ["echo storm -rf; ls"],
    ["rm -r a; echo -f"],
  ])("no marca %s", (cmd) => {
    expect(m(cmd)).toBeUndefined();
  });
});

describe("quoting de shell que no cambia el comando (G2)", () => {
  const evasions = [
    "\\rm -rf ~",
    '"rm" -rf ~',
    "'rm' -rf ~",
    "r\\m -rf ~",
    "$(echo rm) -rf ~",
    "`echo rm` -rf ~",
    "rm${IFS}-rf${IFS}~",
    "rm$IFS-rf$IFS~",
    "rm --recur --forc ~",
    "rm -r --fo ~",
    "\\git push -f",
    "git push --forc origin main",
    "\\kubectl delete ns prod",
    '"npm" publish',
  ];
  it.each(evasions)("sigue prohibido: %s", (command) => {
    expect(watchOk("Bash", { command }, DEFAULT_FORBIDDEN)).toBe(false);
  });

  const allowed = ["ls -la", "rm file.txt", "rm -r dir", "grep -rf patterns.txt .", "echo 'rm -r is bad'", "git push origin main", "git push --follow-tags", "npm test"];
  it.each(allowed)("no marca de más: %s", (command) => {
    expect(watchOk("Bash", { command }, DEFAULT_FORBIDDEN)).toBe(true);
  });

  it("unquoteShell", () => {
    expect(unquoteShell("\\rm '-rf' \"$HOME\"")).toBe("rm -rf $HOME");
    expect(unquoteShell("rm${IFS}-r")).toBe("rm -r");
  });
});

describe("sujeto y wok", () => {
  it("Bash usa el comando; otros tools el tool_input en JSON", () => {
    expect(forbiddenSubject("Bash", { command: "rm -rf x" })).toBe("rm -rf x");
    expect(forbiddenSubject("mcp__shell__run", { cmd: "rm -rf x" })).toBe('{"cmd":"rm -rf x"}');
    expect(watchOk("mcp__shell__run", { cmd: "rm -rf x" }, DEFAULT_FORBIDDEN)).toBe(false);
    expect(watchOk("Bash", { command: "ls" }, DEFAULT_FORBIDDEN)).toBe(true);
    expect(watchOk("Write", { file_path: "/tmp/a" }, DEFAULT_FORBIDDEN)).toBe(true);
  });

  it("un input no serializable se trata como prohibido", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(watchOk("X", cyclic, DEFAULT_FORBIDDEN)).toBe(false);
  });

  it("compileRules acepta regex válidas y rechaza inválidas", () => {
    const ok = compileRules(["^docker push"], "c-");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(matchForbidden("docker push img", ok.rules)).toBe("c-0");
    expect(compileRules(["("], "c-").ok).toBe(false);
  });
});
