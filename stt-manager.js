/**
 * Mac Apple Silicon local STT via mlx-whisper-small.
 * Installs to userData/stt/ (venv, models, optional ffmpeg).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const STT_ENGINE = 'mlx-whisper-small';
const STT_MODEL = 'mlx-community/whisper-small-mlx';
const READY_FILENAME = 'READY.json';

/** @type {import('electron').App | null} */
let electronApp = null;
/** @type {boolean} */
let installInProgress = false;

const INSTALL_COMPONENTS = [
  {
    id: 'python-deps',
    label: 'mlx-whisper 及 Python 依赖（MLX、PyTorch 等）',
    sizeLabel: '约 800 MB – 1.2 GB',
  },
  {
    id: 'model',
    label: 'Whisper Small 语音识别模型（mlx-community/whisper-small-mlx）',
    sizeLabel: '约 460 MB',
  },
  {
    id: 'ffmpeg',
    label: 'ffmpeg 音频工具（系统未安装时自动下载）',
    sizeLabel: '约 45 MB',
  },
];

function initSttManager(app) {
  electronApp = app;
}

function getSttRoot() {
  if (!electronApp) throw new Error('STT manager not initialized');
  return path.join(electronApp.getPath('userData'), 'stt');
}

function getReadyPath() {
  return path.join(getSttRoot(), READY_FILENAME);
}

function readReadyMeta() {
  try {
    return JSON.parse(fs.readFileSync(getReadyPath(), 'utf8'));
  } catch {
    return null;
  }
}

function getPlatformSupport() {
  if (process.platform !== 'darwin') {
    return { supported: false, reason: 'not-mac', message: '语音识别目前仅支持 macOS。' };
  }
  if (process.arch !== 'arm64') {
    return {
      supported: false,
      reason: 'intel-mac',
      message: 'Intel 芯片 Mac 不支持本地语音识别（需 Apple Silicon M 系列）。',
    };
  }
  const release = os.release();
  const darwinMajor = Number.parseInt(release.split('.')[0], 10);
  if (Number.isFinite(darwinMajor) && darwinMajor < 23) {
    return {
      supported: false,
      reason: 'macos-old',
      message: '需要 macOS 14 Sonoma 或更高版本。',
    };
  }
  return { supported: true, reason: null, message: null };
}

function getVenvPython() {
  return path.join(getSttRoot(), 'venv', 'bin', 'python3');
}

function getVenvPip() {
  return path.join(getSttRoot(), 'venv', 'bin', 'pip3');
}

function getBundledFfmpeg() {
  return path.join(getSttRoot(), 'bin', 'ffmpeg');
}

function trimProcessOutput(text, maxLen = 12000) {
  const raw = String(text || '');
  if (raw.length <= maxLen) return raw;
  return raw.slice(-maxLen);
}

function formatProcessError(stderr, stdout, fallback) {
  const combined = trimProcessOutput(`${stderr || ''}\n${stdout || ''}`).trim();
  if (!combined) return fallback;
  const lines = combined.split('\n').map((l) => l.trim()).filter(Boolean);
  const hfLine = lines.find((l) => /RepositoryNotFoundError|401 Client Error|404 Client Error/i.test(l));
  if (hfLine) return hfLine;
  const errLine = [...lines].reverse().find((l) => /Error|Exception|failed|invalid/i.test(l));
  if (errLine) return errLine;
  return lines.slice(-3).join('\n');
}

function runProcess(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      ...options,
      env: { ...process.env, ...(options.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (options.onStdout) options.onStdout(chunk.toString());
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (options.onStderr) options.onStderr(chunk.toString());
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(new Error(formatProcessError(stderr, stdout, `${cmd} exited with code ${code}`)));
      }
    });
  });
}

function commandExists(cmd) {
  return new Promise((resolve) => {
    const proc = spawn('which', [cmd]);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function findSystemPython3() {
  const candidates = ['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
  for (const cmd of candidates) {
    try {
      const result = await runProcess(cmd, ['--version']);
      const combined = `${result.stdout}\n${result.stderr}`;
      if (/python 3\.\d+/i.test(combined)) {
        return cmd;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = (url.startsWith('https') ? https : http).get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        downloadFile(response.headers.location, destPath, onProgress).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败 HTTP ${response.statusCode}`));
        return;
      }
      const total = Number.parseInt(response.headers['content-length'] || '0', 10);
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total > 0) onProgress(received / total);
      });
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    });
    request.on('error', reject);
    file.on('error', reject);
  });
}

async function ensureFfmpeg(progress) {
  const bundled = getBundledFfmpeg();
  if (fs.existsSync(bundled)) {
    try {
      fs.chmodSync(bundled, 0o755);
    } catch {
      // ignore
    }
    return bundled;
  }
  if (await commandExists('ffmpeg')) {
    return 'ffmpeg';
  }

  progress?.({ stage: 'ffmpeg', message: '正在下载 ffmpeg…', percent: 50 });
  const binDir = path.join(getSttRoot(), 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const zipPath = path.join(binDir, 'ffmpeg.zip');

  await downloadFile('https://evermeet.cx/ffmpeg/getrelease/zip', zipPath, (ratio) => {
    progress?.({ stage: 'ffmpeg', message: '正在下载 ffmpeg…', percent: Math.round(ratio * 100) });
  });

  await runProcess('unzip', ['-o', '-j', zipPath, '-d', binDir]);
  const extracted = path.join(binDir, 'ffmpeg');
  if (!fs.existsSync(extracted)) {
    throw new Error('ffmpeg 解压失败');
  }
  fs.chmodSync(extracted, 0o755);
  try {
    fs.unlinkSync(zipPath);
  } catch {
    // ignore
  }
  return extracted;
}

function buildSttEnv(ffmpegPath) {
  const sttRoot = getSttRoot();
  const env = {
    ...process.env,
    HF_HOME: path.join(sttRoot, 'hf-cache'),
    HF_HUB_CACHE: path.join(sttRoot, 'hf-cache'),
    XDG_CACHE_HOME: path.join(sttRoot, 'cache'),
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
  };
  if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
    env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${env.PATH || ''}`;
  }
  return env;
}

async function installStt(progress) {
  if (installInProgress) {
    return { ok: false, error: '正在安装中，请稍候…' };
  }

  const support = getPlatformSupport();
  if (!support.supported) {
    return { ok: false, error: support.message };
  }

  installInProgress = true;
  const sttRoot = getSttRoot();
  fs.mkdirSync(sttRoot, { recursive: true });
  let heartbeatTimer = null;
  let lastProgressAt = Date.now();
  let lastPercent = 15;

  const reportProgress = (payload) => {
    lastProgressAt = Date.now();
    if (typeof payload?.percent === 'number') lastPercent = payload.percent;
    progress?.(payload);
  };

  heartbeatTimer = setInterval(() => {
    if (Date.now() - lastProgressAt > 8000) {
      reportProgress({
        stage: 'working',
        message: '仍在安装中，请耐心等待（依赖包较大）…',
        percent: lastPercent,
      });
      lastProgressAt = Date.now();
    }
  }, 8000);

  try {
    reportProgress({ stage: 'check', message: '正在检测 Python 3…', percent: 5 });
    const systemPython = await findSystemPython3();
    if (!systemPython) {
      return {
        ok: false,
        error: '未检测到 Python 3。请从 https://www.python.org/downloads/ 安装 Python 3.10 或更高版本后重试。',
        needsPython: true,
      };
    }

    reportProgress({ stage: 'venv', message: '正在创建 Python 虚拟环境…', percent: 10 });
    const venvDir = path.join(sttRoot, 'venv');
    if (!fs.existsSync(path.join(venvDir, 'bin', 'python3'))) {
      await runProcess(systemPython, ['-m', 'venv', venvDir]);
    }

    const python = getVenvPython();

    reportProgress({ stage: 'pip', message: '正在安装 mlx-whisper（体积较大，请耐心等待）…', percent: 15 });
    await runProcess(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], { env: buildSttEnv() });
    await runProcess(
      python,
      ['-m', 'pip', 'install', 'mlx-whisper'],
      {
        env: buildSttEnv(),
        onStderr: (text) => {
          const line = text.trim().split('\n').pop();
          if (line && /Downloading|Installing|Collecting|Successfully/i.test(line)) {
            reportProgress({ stage: 'pip', message: line.slice(0, 140), percent: 35 });
          }
        },
        onStdout: (text) => {
          const line = text.trim().split('\n').pop();
          if (line && /Downloading|Installing|Collecting|Successfully/i.test(line)) {
            reportProgress({ stage: 'pip', message: line.slice(0, 140), percent: 35 });
          }
        },
      },
    );

    reportProgress({ stage: 'ffmpeg', message: '正在配置 ffmpeg…', percent: 55 });
    const ffmpegPath = await ensureFfmpeg(reportProgress);

    reportProgress({ stage: 'model', message: '正在下载 Whisper Small 模型…', percent: 65 });
    const env = buildSttEnv(ffmpegPath);
    const prefetchScript = `
import os
from huggingface_hub import snapshot_download
cache = os.environ.get("HF_HUB_CACHE") or os.environ.get("HF_HOME")
snapshot_download(repo_id=${JSON.stringify(STT_MODEL)}, cache_dir=cache)
print("OK")
`;
    await runProcess(python, ['-c', prefetchScript], {
      env,
      onStderr: (text) => {
        if (/Fetching|Downloading|snapshot/i.test(text)) {
          reportProgress({ stage: 'model', message: '正在下载模型…', percent: 80 });
        }
      },
      onStdout: (text) => {
        if (/Fetching|Downloading/i.test(text)) {
          reportProgress({ stage: 'model', message: '正在下载模型…', percent: 80 });
        }
      },
    });

    reportProgress({ stage: 'verify', message: '正在验证安装…', percent: 92 });
    await runProcess(python, ['-c', 'import mlx_whisper; print("OK")'], { env });

    const meta = {
      engine: STT_ENGINE,
      model: STT_MODEL,
      installedAt: new Date().toISOString(),
      pythonPath: python,
      ffmpegPath,
    };
    fs.writeFileSync(getReadyPath(), JSON.stringify(meta, null, 2), 'utf8');

    reportProgress({ stage: 'done', message: '语音识别已就绪', percent: 100 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || '安装失败' };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    installInProgress = false;
  }
}

async function uninstallStt() {
  if (installInProgress) {
    return { ok: false, error: '正在安装中，请稍候再卸载。' };
  }
  const sttRoot = getSttRoot();
  try {
    if (fs.existsSync(sttRoot)) {
      fs.rmSync(sttRoot, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || '卸载失败' };
  }
}

function isSttReady() {
  const support = getPlatformSupport();
  if (!support.supported) return false;
  const meta = readReadyMeta();
  if (!meta) return false;
  const python = getVenvPython();
  return fs.existsSync(python) && fs.existsSync(getReadyPath());
}

function getSttStatus() {
  const support = getPlatformSupport();
  const ready = isSttReady();
  const meta = readReadyMeta();
  return {
    supported: support.supported,
    reason: support.reason,
    message: support.message,
    ready,
    installing: installInProgress,
    engine: ready ? STT_ENGINE : null,
    model: ready ? STT_MODEL : null,
    installedAt: meta?.installedAt || null,
    components: INSTALL_COMPONENTS,
    totalSizeLabel: '合计约 1.3 – 1.7 GB（视网络与系统是否已有 ffmpeg 略有浮动）',
  };
}

async function transcribeAudioFile(audioPath) {
  if (!isSttReady()) {
    return { ok: false, error: '语音识别未安装或未就绪' };
  }
  if (!audioPath || !fs.existsSync(audioPath)) {
    return { ok: false, error: '音频文件不存在' };
  }

  const meta = readReadyMeta();
  const python = meta?.pythonPath || getVenvPython();
  const ffmpegPath = meta?.ffmpegPath || getBundledFfmpeg();
  const env = buildSttEnv(fs.existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg');

  const script = `
import json, sys
import mlx_whisper
result = mlx_whisper.transcribe(
    sys.argv[1],
    path_or_hf_repo=${JSON.stringify(STT_MODEL)},
)
print(json.dumps({"text": result.get("text", "")}, ensure_ascii=False))
`;

  try {
    const { stdout } = await runProcess(python, ['-c', script, audioPath], { env });
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    const parsed = JSON.parse(line || '{}');
    return { ok: true, text: String(parsed.text || '').trim() };
  } catch (err) {
    return { ok: false, error: err.message || '识别失败' };
  }
}

module.exports = {
  initSttManager,
  getSttStatus,
  installStt,
  uninstallStt,
  transcribeAudioFile,
  isSttReady,
  INSTALL_COMPONENTS,
};
