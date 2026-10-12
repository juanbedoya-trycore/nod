# programs.orbit: instala el mod de Orbit en todos los perfiles de Claude Code y lo mantiene al día.
#
# Cada `switch` (y cada vez que aparece un perfil nuevo de ws) ejecuta orbit-sync: registra el marketplace
# del plugin en el perfil, instala o actualiza orbit@orbit y quita el orbit@orbit-local del instalador
# antiguo de Orbit (si estuvieran los dos, cada evento saldría dos veces). No toca nada si la versión
# instalada ya es la del flake.
self:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.orbit;
  home = config.home.homeDirectory;
  marketplace = "${config.xdg.dataHome}/orbit/claude-plugin";
  wsProfiles = "${config.xdg.stateHome}/ws/claude";
  sync = pkgs.writeShellApplication {
    name = "orbit-sync";
    runtimeInputs = [ pkgs.coreutils pkgs.jq ];
    text = ''
      # orbit-sync [--force]: instala o actualiza el mod de Orbit en los perfiles de Claude Code.
      claude=${lib.escapeShellArg cfg.claude}
      mkt=${lib.escapeShellArg marketplace}
      want=$(jq -r .version "$mkt/.claude-plugin/plugin.json")
      force=''${1:-}
      if [ ! -x "$claude" ]; then
        echo "orbit-sync: no encuentro claude en $claude; el mod se instalará en el siguiente switch" >&2
        exit 0
      fi
      dirs=(${lib.escapeShellArgs cfg.profiles})
      if [ ''${#dirs[@]} -eq 0 ]; then
        dirs=("${home}/.claude")
        for d in "${wsProfiles}"/*/; do [ -d "$d" ] && dirs+=("''${d%/}"); done
      fi
      fallos=0
      for d in "''${dirs[@]}"; do
        c() { CLAUDE_CONFIG_DIR="$d" "$claude" plugin "$@"; }
        mkdir -p "$d"
        plugins=$(c list --json 2>/dev/null || echo '[]')
        have=$(jq -r '[.[] | select(.id == "orbit@orbit" and .scope == "user")][0].version // ""' <<<"$plugins")
        if [ "$force" != "--force" ] && [ "$have" = "$want" ]; then continue; fi
        # El instalador antiguo de Orbit (tools/install/install-mac.sh) dejaba orbit@orbit-local:
        # con los dos activos cada evento saldría dos veces.
        if jq -e 'any(.[]; .id == "orbit@orbit-local")' <<<"$plugins" >/dev/null; then
          c uninstall orbit@orbit-local --scope user >/dev/null 2>&1 || c uninstall orbit@orbit-local >/dev/null 2>&1 || true
        fi
        mkts=$(c marketplace list --json 2>/dev/null || echo '[]')
        if jq -e 'any(.[]; .name == "orbit-local")' <<<"$mkts" >/dev/null; then
          c marketplace remove orbit-local >/dev/null 2>&1 || true
        fi
        if jq -e 'any(.[]; .name == "orbit")' <<<"$mkts" >/dev/null; then
          c marketplace update orbit >/dev/null 2>&1 || true
        else
          c marketplace add "$mkt" >/dev/null 2>&1 || true
        fi
        if [ -n "$have" ]; then
          c update orbit@orbit >/dev/null 2>&1 || true
        else
          c install orbit@orbit --scope user >/dev/null 2>&1 || true
        fi
        c enable orbit@orbit --scope user >/dev/null 2>&1 || true
        now=$(c list --json 2>/dev/null | jq -r '[.[] | select(.id == "orbit@orbit" and .scope == "user")][0].version // ""')
        if [ "$now" = "$want" ]; then
          echo "orbit-sync: orbit $want en ''${d/#$HOME/\~}"
        else
          echo "orbit-sync: $d quedó con '$now' en vez de $want (prueba: CLAUDE_CONFIG_DIR=$d $claude plugin install orbit@orbit)" >&2
          fallos=$((fallos + 1))
        fi
      done
      exit "$fallos"
    '';
  };
in {
  options.programs.orbit = {
    enable = lib.mkEnableOption "el mod de Orbit en Claude Code (sesiones y permisos en el reloj)";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.plugin;
      description = "El plugin de Claude Code (con su marketplace).";
    };
    claude = lib.mkOption {
      type = lib.types.str;
      default = "${home}/.local/bin/claude";
      description = "Binario de claude (2.1.296 o más reciente) con el que se instala el plugin.";
    };
    profiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Directorios de configuración de Claude Code. Vacío: ~/.claude y los perfiles de ws (~/.local/state/ws/claude/*).";
    };
    watchProfiles = lib.mkOption {
      type = lib.types.bool;
      default = pkgs.stdenv.isDarwin;
      description = "Instala el mod también en los perfiles de ws que se creen después (agente de launchd).";
    };
  };

  config = lib.mkIf cfg.enable {
    # Ruta estable para el marketplace: Claude la guarda; el enlace cambia de destino en cada versión.
    xdg.dataFile."orbit/claude-plugin".source = cfg.package;
    home.packages = [ sync ];

    home.activation.orbit = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      run ${sync}/bin/orbit-sync || echo "orbit: el mod no quedó instalado en todos los perfiles (orbit-sync para reintentar)" >&2
    '';

    launchd.agents.orbit-sync = lib.mkIf cfg.watchProfiles {
      enable = true;
      config = {
        ProgramArguments = [ "${sync}/bin/orbit-sync" ];
        WatchPaths = [ wsProfiles ];
        StandardErrorPath = "${home}/Library/Logs/orbit-sync.log";
        StandardOutPath = "${home}/Library/Logs/orbit-sync.log";
      };
    };
  };
}
