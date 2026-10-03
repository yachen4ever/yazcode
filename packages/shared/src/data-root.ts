/**
 * yazcode 用户级数据根目录名（~/.yazcode）。
 *
 * 与官方 ZCode 客户端的 ~/.zcode 命名空间隔离，双方互不读写。
 * 旧值仅供 migrateLegacyZCodeDataRoot 的一次性迁移逻辑使用；
 * 工作区项目级 .zcode 目录（项目内 skills/commands/plugins/config）属于项目
 * 命名空间，不受本常量影响。
 */
export const ZCODE_DATA_ROOT_DIR_NAME = ".yazcode";
/** 官方 ZCode 客户端的历史数据根。 */
export const LEGACY_ZCODE_DATA_ROOT_DIR_NAME = ".zcode";
/** yazcode 前身（zcodium 分支期间短暂使用）的历史数据根；迁移时较新者优先。 */
export const LEGACY_INTERIM_DATA_ROOT_DIR_NAME = ".zcodium";
export const LEGACY_MIGRATION_MARKER_FILE = ".migrated-to-yazcode";
/** 迁移源按新→旧排列：两个 legacy 同时存在时优先采用较新的 .zcodium。 */
export const LEGACY_DATA_ROOT_DIRS = [
  LEGACY_INTERIM_DATA_ROOT_DIR_NAME,
  LEGACY_ZCODE_DATA_ROOT_DIR_NAME,
] as const;
