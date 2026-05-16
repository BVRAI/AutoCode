// Patterns ported from v6/src/Automax.App/Tools/AutoCode/AutoCodeRunShellTool.cs:73-112,
// extended for cross-platform coverage (POSIX + PowerShell + cmd).

export interface SafetyPattern {
  // Human-readable reason shown to the user when matched.
  reason: string;
  // Regex tested against the (lowercased) command string.
  re: RegExp;
}

// Commands the agent must never run. These are catastrophic, almost always wrong, or target
// data the agent should never touch.
export const HARD_BLOCK: SafetyPattern[] = [
  { reason: 'recursive root deletion', re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\*|\$home|\$env:userprofile)(?!\w)/i },
  { reason: 'powershell recursive root deletion', re: /\bremove-item\b[^|;]*-recurse[^|;]*(c:\\|\$home|\$env:userprofile)/i },
  { reason: 'windows recursive delete from root', re: /\bdel\s+\/s\s+c:\\?\s*$/i },
  { reason: 'rd /s recursive', re: /\brd\s+\/s\s+\/q?\s*c:\\?/i },
  { reason: 'disk format', re: /\bformat\s+[a-z]:/i },
  { reason: 'diskpart', re: /\bdiskpart\b/i },
  { reason: 'bcdedit', re: /\bbcdedit\b/i },
  { reason: 'shred / cipher wipe', re: /\b(shred|cipher\s+\/w)\b/i },
  { reason: 'shutdown / reboot', re: /\b(shutdown|halt|reboot|restart-computer|stop-computer)\b/i },
  { reason: 'fork bomb', re: /:\(\)\s*\{[^}]*\}\s*;\s*:/ },
  { reason: 'mkfs filesystem creation', re: /\bmkfs(\.\w+)?\b/i },
  { reason: 'dd to raw device', re: /\bdd\s+[^|;]*of=\/dev\/(sd|hd|nvme)/i },
  // Protect Automax & autocode internal state
  { reason: 'targets Automax user.db', re: /user\.db\b/i },
  { reason: 'targets Automax WebView2 profile', re: /Automax[\\/]WebView2/i },
  { reason: 'targets autocode data dir', re: /[\\/]\.autocode([\\/]|$)/i },
  { reason: 'targets autocode LocalAppData', re: /LocalAppData[\\\/]+autocode/i },
];

// Commands that are sometimes legitimate but easy to get wrong. The user must approve.
export const SOFT_CONFIRM: SafetyPattern[] = [
  { reason: 'destructive git: reset --hard', re: /\bgit\s+reset\s+--hard\b/i },
  { reason: 'destructive git: clean -f', re: /\bgit\s+clean\s+-[a-z]*f/i },
  { reason: 'force push', re: /\bgit\s+push\s+.*--force(-with-lease)?\b/i },
  { reason: 'force push (short flag)', re: /\bgit\s+push\s+.*\s-f\b/i },
  { reason: 'force push -f', re: /\bgit\s+push\s+-f\b/i },
  { reason: 'git branch -D', re: /\bgit\s+branch\s+-D\b/i },
  { reason: 'recursive delete inside project', re: /\b(rm\s+-rf?|remove-item.*-recurse)\b/i },
  { reason: 'sudo / runas', re: /\b(sudo|runas)\b/i },
  { reason: 'package uninstall', re: /\b(npm|pnpm|yarn|pip|pipx|cargo|gem|brew)\s+(uninstall|remove)\b/i },
  { reason: 'global package install', re: /\b(npm|pnpm|yarn)\s+(install|i|add)\b[^|;]*\s(-g|--global)\b/i },
  { reason: 'touches ~/.ssh', re: /[\\\/]\.ssh([\\\/]|$)/i },
  { reason: 'touches AppData', re: /[\\\/]AppData[\\\/]/i },
  { reason: 'modifies global git config', re: /\bgit\s+config\s+--global\b/i },
  { reason: 'curl | bash piping', re: /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(bash|sh|powershell|pwsh|python|node)/i },
  { reason: 'kill process tree', re: /\b(taskkill|kill\s+-9|stop-process)\b/i },
  { reason: 'docker volume rm / system prune', re: /\bdocker\s+(volume\s+rm|system\s+prune)\b/i },
  { reason: 'database drop', re: /\b(drop\s+database|drop\s+table)\b/i },
];
