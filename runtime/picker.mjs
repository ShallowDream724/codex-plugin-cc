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

const clipboard = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$image = $null
$imagePath = $null
try {
  if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
    @{ paths = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }) } | ConvertTo-Json -Compress
  } elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $image = [System.Windows.Forms.Clipboard]::GetImage()
    if ($null -eq $image) { throw 'Image unavailable' }
    $directory = Join-Path ([System.IO.Path]::GetTempPath()) 'codex-subagents-attachments'
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    $imagePath = Join-Path $directory ([System.Guid]::NewGuid().ToString() + '.png')
    $image.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
    @{ paths = @($imagePath) } | ConvertTo-Json -Compress
  } else { '{"paths":[],"error":"剪贴板中没有文件或图片。"}' }
} catch {
  if ($imagePath) { Remove-Item -LiteralPath $imagePath -Force -ErrorAction SilentlyContinue }
  '{"paths":[],"error":"无法读取剪贴板附件，请重试。"}'
} finally { if ($image) { $image.Dispose() } }
`;

async function runPicker({ platform, cwd, launch, mode }) {
  const paste = mode === 'clipboard';
  if (platform !== 'win32') return paste ? { paths: [], unsupported: true, error: '当前系统不支持粘贴附件。' } : { paths: [], unsupported: true };
  return new Promise(resolve => {
    let output = '', settled = false; const decoder = new StringDecoder('utf8');
    let child;
    try {
      child = launch('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(paste ? clipboard : dialog, 'utf16le').toString('base64')], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CODEX_SUBAGENTS_PICKER_CWD: cwd },
      });
    } catch { resolve(paste ? { paths: [], error: '无法启动剪贴板附件读取，请重试。' } : { paths: [], unsupported: true }); return; }
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill(); finish({ paths: [], error: paste ? '读取剪贴板附件已超时，请重试。' : '文件选择已超时，请重试或输入文件路径。' }); }, paste ? 15000 : 180000);
    child.stdout?.on('data', chunk => {
      output += decoder.write(chunk);
      if (Buffer.byteLength(output) > 1024 * 1024) { child.kill(); finish({ paths: [], error: paste ? '剪贴板文件路径过多。' : '所选文件路径过多。' }); }
    });
    child.once('error', () => finish(paste ? { paths: [], error: '无法启动剪贴板附件读取，请重试。' } : { paths: [], unsupported: true }));
    child.once('close', code => {
      output += decoder.end();
      if (code !== 0) { finish(paste ? { paths: [], error: '无法读取剪贴板附件，请重试。' } : { paths: [], unsupported: true }); return; }
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
        if (!Array.isArray(result.paths) || result.paths.some(p => typeof p !== 'string')) throw new Error('Invalid file selection');
        finish(paste && typeof result.error === 'string' ? { paths: result.paths, error: result.error } : { paths: result.paths });
      } catch { finish({ paths: [], error: paste ? '无法读取剪贴板附件，请重试。' : '无法读取所选文件，请输入文件路径。' }); }
    });
  });
}

export async function pickLocalFiles({ platform = process.platform, cwd = process.cwd(), launch = spawn } = {}) {
  return runPicker({ platform, cwd, launch, mode: 'dialog' });
}

export async function readClipboardAttachments({ platform = process.platform, cwd = process.cwd(), launch = spawn } = {}) {
  return runPicker({ platform, cwd, launch, mode: 'clipboard' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await (process.argv[2] === '--clipboard' ? readClipboardAttachments() : pickLocalFiles())) + '\n');
}
