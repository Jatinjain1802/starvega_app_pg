const preset = require('@react-native/jest-preset');

module.exports = {
  preset: '@react-native/jest-preset',
  transform: {
    ...preset.transform,
    '^.+\\.(js|jsx)$': 'babel-jest',
  },
};
