const fs = require('fs');
const path = require('path');
const { cfg } = require('../config');

/**
 * 감지 이미지를 디스크에 저장한다.
 * 경로 형식: <IMAGE_DIR>/<tenantId>/<YYYY-MM-DD>/<시각>_<난수>.jpg
 * (운영 규모가 커지면 S3 등 오브젝트 스토리지로 교체하세요)
 */
function saveImage(tenantId, base64) {
  // 무료 호스팅(Render 등)은 디스크가 재배포 때 초기화됩니다.
  // SAVE_IMAGES=false 로 두면 이미지를 저장하지 않고 기록만 남깁니다.
  if (process.env.SAVE_IMAGES === 'false') return null;

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const dir = path.join(cfg.image.dir, String(tenantId), day);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  const file = `${stamp}_${rand}.jpg`;
  const full = path.join(dir, file);

  fs.writeFileSync(full, Buffer.from(base64, 'base64'));

  // DB에는 상대 경로만 저장한다
  return path.join(String(tenantId), day, file).replace(/\\/g, '/');
}

function imageFullPath(relPath) {
  return path.join(cfg.image.dir, relPath);
}

/**
 * 보관 기간이 지난 이미지를 삭제한다.
 * 개인정보보호법상 영상은 목적 달성 후 지체 없이 파기해야 하므로
 * 반드시 주기적으로 실행하세요 (cron 권장).
 */
function cleanupOldImages() {
  const root = cfg.image.dir;
  if (!fs.existsSync(root)) return { deleted: 0 };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - cfg.image.retentionDays);
  let deleted = 0;

  for (const tenant of fs.readdirSync(root)) {
    const tdir = path.join(root, tenant);
    if (!fs.statSync(tdir).isDirectory()) continue;
    for (const day of fs.readdirSync(tdir)) {
      const d = new Date(day);
      if (isNaN(d.getTime()) || d >= cutoff) continue;
      const ddir = path.join(tdir, day);
      for (const f of fs.readdirSync(ddir)) {
        fs.unlinkSync(path.join(ddir, f));
        deleted++;
      }
      fs.rmdirSync(ddir);
    }
  }
  return { deleted };
}

module.exports = { saveImage, imageFullPath, cleanupOldImages };
