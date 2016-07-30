var event = {};

var context = {
  invokeid: 'invokeid',
  done: function (err, message) {
    return;
  },
  succeed: function () {
    return;
  },
  fail: function (error) {
    console.error(error);
    return;
  }
};

var lambda = require("./index");
lambda.handler(event, context);
