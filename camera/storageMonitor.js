const { exec } = require("child_process");

function getDiskUsage() {
  return new Promise((resolve, reject) => {
    exec("df -k /", (err, stdout) => {
      if (err) return reject(err);

      const lines = stdout.split("\n");
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
  });
}

module.exports = { getDiskUsage };
