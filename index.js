'use strict';

const eejs = require('ep_etherpad-lite/node/eejs/');

exports.eejsBlock_editbarMenuLeft = (hook, args, cb) => {
  args.content += eejs.require('ep_vim/templates/editbarButtons.ejs');
  return cb();
};
