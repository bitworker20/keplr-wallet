module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "\\.(css|scss|sass)$": "identity-obj-proxy",
    // Mirrors the webpack alias and tsconfig paths for the vendored BitPoker
    // session layer. First match wins, so fixtures must precede the catch-all.
    "^@bitpoker/poker-session/fixtures/(.*)$":
      "<rootDir>/vendor/bitpoker-session/fixtures/$1",
    "^@bitpoker/poker-session/(.*)$":
      "<rootDir>/vendor/bitpoker-session/src/$1",
  },
  testMatch: ["**/src/**/?(*.)+(spec|test).[jt]s?(x)"],
};
