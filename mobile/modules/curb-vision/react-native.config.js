/* global __dirname */
module.exports = {
  dependency: {
    platforms: {
      ios: { podspecPath: require('path').join(__dirname, 'CurbVision.podspec') },
      android: null,
    },
  },
};
