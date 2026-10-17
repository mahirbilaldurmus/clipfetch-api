
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join("/tmp", "clipfetch-downloads");

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

app.use(cors({
  origin: "https://quiet-torte-c64a9a.netlify.app"
}));
app.use(express.json({ limit: "1mb" }));

const PLATFORMS = {
  tiktok: ["tiktok.com"],
  instagram: ["instagram.com"],
  youtube: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  x: ["x.com", "twitter.com"]
};

function detectPlatform(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;

    const host = url.hostname.toLowerCase();

    for (const [platform, domains] of Object.entries(PLATFORMS)) {
      if (domains.some(domain =>
        host === domain || host.endsWith("." + domain)
      )) {
        return platform;
      }
    }
  } catch {}

  return null;
}

app.get("/", (req, res) => {
  res.send("ClipFetch API çalışıyor.");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "clipfetch-api" });
});

app.post("/download", (req, res) => {
  const videoUrl = req.body?.url;
  const requestedPlatform = req.body?.platform;

  if (typeof videoUrl !== "string" || videoUrl.length > 2048) {
    return res.status(400).json({
      error: "Geçerli bir video bağlantısı gir."
    });
  }

  const detectedPlatform = detectPlatform(videoUrl);

  if (!detectedPlatform) {
    return res.status(400).json({
      error: "Desteklenen platformlardan geçerli bir HTTPS bağlantısı gir."
    });
  }

  if (
    requestedPlatform &&
    requestedPlatform !== detectedPlatform
  ) {
    return res.status(400).json({
      error: `Bu bağlantı ${detectedPlatform} platformuna ait. Doğru platformu seç.`
    });
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const output = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);

  const downloader = spawn("yt-dlp", [
    "--no-playlist",
    "--max-filesize", "100M",
    "-f", "best[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "-o", output,
    videoUrl
  ]);

  let errorText = "";
  let responded = false;

  downloader.stderr.on("data", data => {
    errorText += data.toString();
  });

  downloader.stdout.on("data", data => {
    console.log(`[yt-dlp ${id}] ${data.toString().trim()}`);
  });

  downloader.on("error", err => {
    console.error(`[yt-dlp ${id}]`, err);

    if (!responded && !res.headersSent) {
      responded = true;
      res.status(500).json({
        error: "İndirme aracı başlatılamadı."
      });
    }
  });

  downloader.on("close", code => {
    if (responded || res.headersSent) return;

    if (code !== 0) {
      console.error(`[yt-dlp ${id}]`, errorText);

      responded = true;
      return res.status(400).json({
        error: "Video indirilemedi. İçerik özel olabilir veya platform erişimi kısıtlamış olabilir."
      });
    }

    const file = fs.readdirSync(DOWNLOAD_DIR)
      .find(name => name.startsWith(id + "."));

    if (!file) {
      responded = true;
      return res.status(500).json({
        error: "İndirilen dosya bulunamadı."
      });
    }

    responded = true;
    res.json({
      downloadUrl: `/files/${encodeURIComponent(file)}`
    });
  });
});

app.get("/files/:name", (req, res) => {
  const name = path.basename(req.params.name);

  if (!/^\d+-[a-z0-9]+\.(mp4|webm|mkv|m4a|mov)$/i.test(name)) {
    return res.status(400).send("Geçersiz dosya.");
  }

  const filePath = path.join(DOWNLOAD_DIR, name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Dosya bulunamadı veya süresi doldu.");
  }

  res.download(filePath, name, err => {
    if (err) {
      console.error(`[download] ${name}:`, err);
      return;
    }

    fs.unlink(filePath, () => {});
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipFetch API running on port ${PORT}`);
});



