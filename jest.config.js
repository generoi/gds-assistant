const defaultConfig = require("@wordpress/scripts/config/jest-unit.config");

module.exports = {
  ...defaultConfig,
  // @wordpress/blocks (block-validation tests) depends on the ESM-only uuid.
  transformIgnorePatterns: [
    "/node_modules/(?!(@wordpress/blocks/node_modules/)?uuid/)",
  ],
};
