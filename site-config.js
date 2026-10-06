'use strict';

/*
 * 官方题库配置
 *
 * 官方加密文件统一使用 .txt 后缀，并放入 official_levels/。
 * 如果你的部署环境不支持自动列目录，请在 officialFiles 中登记文件名，
 * 或维护 official_levels/manifest.json。
 * 自定义域名部署到 GitHub Pages 时，建议填写 officialRepository，
 * 这样页面可通过 GitHub API 自动发现 official_levels/ 中的 .txt 文件。
 */
window.CHESS_SITE_CONFIG = {
  officialFolder: 'official_levels',
  officialFiles: [],
  officialRepository: '',
  officialBranch: 'main'
};
