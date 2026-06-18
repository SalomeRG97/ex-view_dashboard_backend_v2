const queue = require('express-queue');

const generalQueue = queue({ activeLimit: 10, queuedLimit: -1 });
const reportQueue = queue({ activeLimit: 3, queuedLimit: -1 });

module.exports = {
  generalQueue,
  reportQueue
};
