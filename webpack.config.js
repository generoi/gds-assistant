import path from 'path';
import defaultConfig from '@wordpress/scripts/config/webpack.config.js';

const __dirname = import.meta.dirname;

// Inject @tailwindcss/postcss into the existing PostCSS loader.
const updatedRules = defaultConfig.module.rules.map((rule) => {
  if (!rule.test?.toString().includes('css')) {
    return rule;
  }

  return {
    ...rule,
    use: rule.use?.map((loader) => {
      if (
        typeof loader === 'object' &&
        loader.loader &&
        loader.loader.includes('postcss-loader')
      ) {
        return {
          ...loader,
          options: {
            ...loader.options,
            postcssOptions: {
              plugins: [['@tailwindcss/postcss', {}]],
            },
          },
        };
      }
      return loader;
    }),
  };
});

export default {
  ...defaultConfig,
  module: {
    ...defaultConfig.module,
    rules: updatedRules,
  },
  entry: {
    'admin-chat': path.resolve(__dirname, 'resources/scripts/admin-chat.jsx'),
  },
  output: {
    ...defaultConfig.output,
    uniqueName: 'gds-assistant',
    path: path.resolve(__dirname, 'build'),
  },
};
