export * from "./messages";
export * from "./service";
// The game-type table (ids, names, validation) — shared by the background
// validator, the approval screen and the poker page so they cannot disagree
// about which games exist.
export {
  POKERCHAIN_GAME_TYPES,
  POKERCHAIN_GAME_TYPE_ZJH,
  POKERCHAIN_GAME_TYPE_TH,
  POKERCHAIN_GAME_TYPE_O8,
  isSupportedGameType,
  gameTypeName,
  supportedGameTypeList,
} from "./proto-writer";
