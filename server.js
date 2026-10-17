

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

app.get("/", (req, res) => {
  res.send("ClipFetch API çalışıyor.");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "clipfetch-api" });
});

app.post("/download", (req, res) => {
  const videoUrl = req.body?.url;

  if (
    typeof videoUrl !== "string" ||
    !/^https:\/\/(www\.)?tiktok\.com\//i.test(videoUrl)
  ) {
    return res.status(400).json({
      error: "Geçerli bir TikTok bağlantısı gir."
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
  let finished = false;

  downloader.stderr.on("data", (data) => {
    errorText += data.toString();
  });

  downloader.stdout.on("data", (data) => {
    console.log(`[yt-dlp ${id}] ${data.toString().trim()}`);
  });

  downloader.on("error", (err) => {
    console.error(`[yt-dlp ${id}] process error:`, err);

    if (!res.headersSent) {
      res.status(500).json({
        error: "İndirme aracı başlatılamadı."
      });
    }
  });

  downloader.on("close", (code) => {
    if (finished) return;
    finished = true;

    if (code !== 0) {
      console.error(`[yt-dlp ${id}] exit code: ${code}`);
      console.error(`[yt-dlp ${id}] stderr: ${errorText || "(boş)"}`);

      return res.status(400).json({
        error: "Video indirilemedi. Render Logs bölümündeki yt-dlp hatasını kontrol et."
      });
    }

    const file = fs.readdirSync(DOWNLOAD_DIR)
      .find(name => name.startsWith(id + "."));

    if (!file) {
      console.error(`[yt-dlp ${id}] Dosya bulunamadı.`);

      return res.status(500).json({
        error: "İndirilen dosya bulunamadı."
      });
    }

    res.json({
      downloadUrl: `/files/${encodeURIComponent(file)}`
    });
  });
});

app.get("/files/:name", (req, res) => {
  const name = path.basename(req.params.name);

  if (!/^\d+-[a-z0-9]+\.(mp4|webm|mkv|m4a)$/i.test(name)) {
    return res.status(400).send("Geçersiz dosya.");
  }

  const filePath = path.join(DOWNLOAD_DIR, name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Dosya bulunamadı veya süresi doldu.");
  }

  res.download(filePath, name, (err) => {
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipFetch API running on port ${PORT}`);
});
