const { exec } = require("child_process");

function checkStorageAndSync(driveLetter = "C:") {
  return new Promise((resolve, reject) => {

    // ==============================
    // 🪟 WINDOWS
    // ==============================
    if (process.platform === "win32") {

      exec("wmic logicaldisk get size,freespace,caption", (err, stdout) => {
        if (err) return reject(err);

        const lines = stdout.trim().split("\n").slice(1);

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);

          if (parts[0] === driveLetter) {
            const free = parseInt(parts[1]);
            const size = parseInt(parts[2]);

            const used = size - free;

            return resolve({
              total: size,
              used: used,
              available: free,
              percentUsed: (used / size) * 100
            });
          }
        }

        reject(new Error("Drive not found"));
      });

    }

    // ==============================
    // 🐧 LINUX / ANDROID / MAC
    // ==============================
    else {

      exec("df -k /", (err, stdout) => {
        if (err) return reject(err);

        const lines = stdout.trim().split("\n");
        const parts = lines[1].split(/\s+/);

        const total = parseInt(parts[1]) * 1024;
        const used = parseInt(parts[2]) * 1024;
        const available = parseInt(parts[3]) * 1024;

        resolve({
          total,
          used,
          available,
          percentUsed: (used / total) * 100
        });
      });

    }

  });
}

module.exports = { checkStorageAndSync };