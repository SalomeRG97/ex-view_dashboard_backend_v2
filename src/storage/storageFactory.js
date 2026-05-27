const LocalStorageService = require('./LocalStorageService');

const useHostinger = process.env.NODE_ENV === 'production' || process.env.STORAGE_PROVIDER === 'hostinger';

let storageService;

if (useHostinger) {
  storageService = require('./HostingerStorageService');
} else {
  storageService = LocalStorageService;
}

module.exports = storageService;
