import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

// Run only after a person presses the attachment button. Paths are data in
// stdout/environment; none is interpolated into executable PowerShell source.
const dialog = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$picker = New-Object System.Windows.Forms.OpenFileDialog
$picker.Title = '添加文件或图片'
$picker.Multiselect = $true
$picker.CheckFileExists = $true
$picker.InitialDirectory = [Environment]::GetEnvironmentVariable('CODEX_SUBAGENTS_PICKER_CWD')
try {
  if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    @{ paths = @($picker.FileNames) } | ConvertTo-Json -Compress
  } else { '{"paths":[]}' }
} finally { $picker.Dispose() }
`;

export async function pickLocalFiles({ platform = process.platform, cwd = process.cwd(), launch = spawn } = {}) {
  if (platform !== 'win32') return { paths: [], unsupported: true };
  return new Promise(resolve => {
    let output = '', settled = false; const decoder = new StringDecoder('utf8');
    const child = launch('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(dialog, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CODEX_SUBAGENTS_PICKER_CWD: cwd },
    });
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill(); finish({ paths: [], error: '文件选择已超时，请重试或输入文件路径。' }); }, 180000);
    child.stdout?.on('data', chunk => {
      output += decoder.write(chunk);
      if (Buffer.byteLength(output) > 1024 * 1024) { child.kill(); finish({ paths: [], error: '所选文件路径过多。' }); }
    });
    child.once('error', () => finish({ paths: [], unsupported: true }));
    child.once('close', code => {
      output += decoder.end();
      if (code !== 0) { finish({ paths: [], unsupported: true }); return; }
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
        if (!Array.isArray(result.paths) || result.paths.some(p => typeof p !== 'string')) throw new Error('Invalid file selection');
        finish({ paths: result.paths });
      } catch { finish({ paths: [], error: '无法读取所选文件，请输入文件路径。' }); }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await pickLocalFiles()) + '\n');
}
