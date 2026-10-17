
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
  } catch {
    return null;
  }

  return null;
}

app.get("/", (req, res) => {
  res.send("ClipFetch API çalışıyor.");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "clipfetch-api"
  });
});

app.post("/download", (req, res) => {
  const videoUrl = req.body?.url;
  const requestedPlatform = req.body?.platform;

  if (
    typeof videoUrl !== "string" ||
    videoUrl.length > 2048
  ) {
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

  // Use EasyDown for YouTube when configured; keep the token server-side.
  if (detectedPlatform === "youtube" && process.env.EASYDOWN_API_KEY) {
    (async () => {
      try {
        const apiResponse = await fetch("https://api.easydown.org/api/v1/platforms/youtube/parse", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + process.env.EASYDOWN_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ url: videoUrl }),
          signal: AbortSignal.timeout(30000)
        });
        const parsed = await apiResponse.json().catch(() => ({}));
        if (!apiResponse.ok || parsed.status !== 200) {
          console.error("[EasyDown] API failed:", apiResponse.status, parsed.msg || parsed.error || "unknown error");
          if (!res.headersSent) res.status(502).json({ error: "YouTube bağlantısı çözümlenemedi. Farklı bir herkese açık video deneyin." });
          return;
        }
        const videos = parsed.data?.media?.videos || parsed.data?.videos || [];
        const video = videos.find(item => item.hasAudio && item.mimeType === "video/mp4") || videos.find(item => item.hasAudio && item.source === "direct") || videos.find(item => item.hasAudio) || videos.find(item => item.mimeType === "video/mp4") || videos[0];
        if (!video?.url) {
          if (!res.headersSent) res.status(502).json({ error: "YouTube için indirilebilir video bulunamadı." });
          return;
        }
        // EasyDown recommends browser-like public headers for YouTube media URLs.
        // Preserve any per-stream headers returned by the API.
        const mediaResponse = await fetch(video.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": "https://www.youtube.com/",
            "Origin": "https://www.youtube.com",
            ...(video.headers || {})
          },
          signal: AbortSignal.timeout(90000)
        });
        if (!mediaResponse.ok || !mediaResponse.body) {
          console.error("[EasyDown] media download failed:", mediaResponse.status);
          if (!res.headersSent) res.status(502).json({ error: "YouTube video dosyası alınamadı. Lütfen tekrar dene." });
          return;
        }
        const mime = (video.mimeType || mediaResponse.headers.get("content-type") || "").toLowerCase();
        const ext = mime.includes("webm") ? "webm" : mime.includes("quicktime") ? "mov" : "mp4";
        const fileName = id + "." + ext;
        const filePath = path.join(DOWNLOAD_DIR, fileName);
        const { Readable } = require("stream");
        const { pipeline } = require("stream/promises");
        await pipeline(Readable.fromWeb(mediaResponse.body), fs.createWriteStream(filePath));
        if (fs.statSync(filePath).size > 100 * 1024 * 1024) {
          fs.unlink(filePath, () => {});
          if (!res.headersSent) res.status(413).json({ error: "Video 100 MB sınırını aşıyor." });
          return;
        }
        if (!res.headersSent) res.json({ downloadUrl: "/files/" + encodeURIComponent(fileName) });
      } catch (err) {
        console.error("[EasyDown] error:", err.message);
        if (!res.headersSent) res.status(502).json({ error: "YouTube indirme servisine ulaşılamadı. API anahtarını ve servis durumunu kontrol et." });
      }
    })();
    return;
  }

  const args = [
    "--no-playlist",
    "--max-filesize", "100M",
    "--js-runtimes", "node",
    "--force-ipv4",
    "--sleep-requests", "1"
  ];

  // Let yt-dlp choose its current default YouTube clients.
  // Forcing tv/web_safari was triggering 403 / bot verification on this host.

  args.push(
    "-f", "best[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "-o", output,
    videoUrl
  );

  const downloader = spawn("yt-dlp", args);

  let errorText = "";
  let responded = false;

  downloader.stderr.on("data", data => {
    errorText += data.toString();
  });

  downloader.stdout.on("data", data => {
    console.log(`[yt-dlp ${id}] ${data.toString().trim()}`);
  });

  downloader.on("error", err => {
    console.error(`[yt-dlp ${id}] process error:`, err);

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
      console.error(`[yt-dlp ${id}] exit code: ${code}`);
      console.error(`[yt-dlp ${id}] stderr: ${errorText}`);

      responded = true;
      return res.status(400).json({
        error: detectedPlatform === "youtube"
          ? "YouTube videoyu sunucumuza vermedi. Erişim kısıtlaması veya doğrulama engeli olabilir."
          : "Video indirilemedi. İçerik özel olabilir veya platform erişimi kısıtlamış olabilir."
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
    return res.status(404).send(
      "Dosya bulunamadı veya süresi doldu."
    );
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


