
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

      // Free fallback: use public Invidious instances as a media proxy for YouTube.
      if (detectedPlatform === "youtube") {
        (async () => {
          const match = videoUrl.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([A-Za-z0-9_-]{11})/);
          const videoId = match?.[1];
          const instances = ["https://inv.nadeko.net", "https://invidious.nerdvpn.de", "https://yt.chocolatemoo53.com", "https://invidious.tiekoetter.com"];
          if (videoId) {
            for (const instance of instances) {
              let fallbackResponse;
              try {
                const endpoint = `${instance}/latest_version?id=${encodeURIComponent(videoId)}&itag=18&local=true`;
                fallbackResponse = await fetch(endpoint, {
                  headers: { "User-Agent": "Mozilla/5.0 ClipFetch/1.0" },
                  redirect: "follow",
                  signal: AbortSignal.timeout(25000)
                });
                const type = (fallbackResponse.headers.get("content-type") || "").toLowerCase();
                if (!fallbackResponse.ok || !fallbackResponse.body || type.includes("text/html") || type.includes("application/json")) {
                  console.error("[Invidious fallback]", instance, "HTTP", fallbackResponse.status, "type", type);
                  if (fallbackResponse.body) await fallbackResponse.body.cancel().catch(() => {});
                  continue;
                }
                const fileName = `${id}.mp4`;
                const filePath = path.join(DOWNLOAD_DIR, fileName);
                const { Readable } = require("stream");
                const { pipeline } = require("stream/promises");
                await pipeline(Readable.fromWeb(fallbackResponse.body), fs.createWriteStream(filePath));
                const stats = fs.statSync(filePath);
                if (stats.size < 1024 || stats.size > 100 * 1024 * 1024) {
                  fs.unlink(filePath, () => {});
                  console.error("[Invidious fallback]", instance, "invalid file size", stats.size);
                  continue;
                }
                console.log("[Invidious fallback] downloaded via", instance, "bytes", stats.size);
                responded = true;
                return res.json({ downloadUrl: `/files/${encodeURIComponent(fileName)}` });
              } catch (err) {
                console.error("[Invidious fallback]", instance, err.message);
                if (fallbackResponse?.body) await fallbackResponse.body.cancel().catch(() => {});
              }
            }
          }
          if (!responded && !res.headersSent) {
            responded = true;
            return res.status(400).json({ error: "YouTube ücretsiz sunucu yedekleri de bu videoyu alamadı. Video kısıtlı olabilir veya sunucular geçici olarak çalışmıyor olabilir." });
          }
        })();
        return;
      }

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


