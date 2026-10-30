import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../dist/web"),
  base = process.env.BASE_PATH || "",
  port = Number(process.env.PORT || 8914);
http
  .createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/telemetry" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2e6) {
          res.writeHead(413).end();
          return;
        }
      }
      try {
        const data = JSON.parse(body),
          id = String(data.id || "device")
            .replace(/[^a-z0-9-]/gi, "")
            .slice(0, 50);
        fs.writeFileSync(
          path.resolve(import.meta.dirname, "../evidence", id + ".json"),
          JSON.stringify(data, null, 2),
        );
        res.end("ok");
      } catch {
        res.writeHead(400).end();
      }
      return;
    }
    let name = decodeURIComponent(url.pathname);
    if (base && name.startsWith(base)) name = name.slice(base.length);
    const file = path.resolve(
      root,
      "." + (name.endsWith("/") ? name + "index.html" : name),
    );
    if (
      !file.startsWith(root + path.sep) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    ) {
      res.writeHead(404).end();
      return;
    }
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".jpg": "image/jpeg",
      ".png": "image/png",
      ".bin": "application/octet-stream",
    };
    res.setHeader(
      "Content-Type",
      mime[path.extname(file)] || "application/octet-stream",
    );
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "0.0.0.0", () => console.log("3D Lab " + port + base));
