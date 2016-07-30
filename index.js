'use strict';

var AWS       = require('aws-sdk'),
    url       = require('url'),
    https     = require('https'),
    domain    = require('domain'),
    PokemonGO = require('pokemon-go-node-api'),
    async     = require('async'),
    pokemonNames = require('./locales/pokemon.ja.json'),
    trainer   = new PokemonGO.Pokeio(),
    icloud = require("find-my-iphone").findmyphone;

/*****************************************************************
* find my iphone
*****************************************************************/

icloud.apple_id = process.env.APPLE_USERNAME || 'USER';
icloud.password = process.env.APPLE_PASSOWRD || 'PASS';
var deviceName  = process.env.APPLE_DEVICE   || 'iPhone SE';

var findMyLocation = function (cb) {
  icloud.getDevices(function(err, devices) {
    if (err) return cb(err);
    var myPhones = devices.filter(function(d) {
      return d.location && d.deviceDisplayName === deviceName;
    });

    if (0 === myPhones.length) {
      return cb();
    }

    cb(null, myPhones[0].location);
  });
}

/*****************************************************************
* find pokemon nearby
*****************************************************************/

var username = process.env.PGO_USERNAME || 'USER';
var password = process.env.PGO_PASSWORD || 'PASS';
var provider = process.env.PGO_PROVIDER || 'google';

var location = {
  type: 'name',
  name: process.env.PGO_LOCATION || 'Yokohama'
};

var login = function (cb) {
  trainer.init(username, password, location, provider, cb);
};

var getPokemonBook = function (cb) {
  trainer.GetInventory(function (err, inventry) {
    if (err) return cb(err);

    var pokedex = inventry.inventory_delta.inventory_items.filter(function (i) {
      return i.inventory_item_data.pokedex_entry;
    }).map(function (i) {
      return i.inventory_item_data.pokedex_entry;
    });

    cb(null, {
      pokedex: pokedex,
      contain: function (pokemonId) {
        return this.pokedex.some(function (p) {
          return pokemonId === p.pokedex_entry_number;
        });
      }
    });
  });
};

var getNeighbors = function (cb) {
  trainer.Heartbeat(function(err, hb) {
    if(err) return cb(err);

    var pokemons = [];
    for (var i = hb.cells.length - 1; i >= 0; i--) {
      if(hb.cells[i].NearbyPokemon[0]) {
        var pokemonId = parseInt(hb.cells[i].NearbyPokemon[0].PokedexNumber);
        var pokemon   = trainer.pokemonlist[pokemonId-1];
        pokemon.name  = pokemonNames[pokemon.id];
        pokemons.push(pokemon);
      }
    }
    cb(null, pokemons);
  });
};

var getNeighborsNotCaught = function (location, cb) {
  async.waterfall([
    login,
    function (cb) {
      trainer.SetLocation(location, function (err) {
        if (err) return cb(err);
        cb();
      });
    },
    getPokemonBook,
    function (book, cb) {
      getNeighbors(function (err, pokemons) {
        if (err) return cb(err);
        cb(null, pokemons.filter(function (p) {
          return book.contain(p.id);
        }));
      });
    }
  ], cb);
};

/*****************************************************************
* post pokemon to slack
*****************************************************************/

var hookUrl = process.env.PGO_SLACK_URL;

var postPokemonToSlack = function(pokemon, cb) {
  var u = hookUrl.split('@');

  var message = {
    url: u[0],
    channel: '@' + u[1],
    icon_emoji: ':yum:',
    text: '[ポケモンレーダー] ' + pokemon.name + ' が 現れました',
    attachments: [{
      image_url: pokemon.img
    }]
  };

  var body = JSON.stringify(message);
  var options = url.parse(message.url);

  options.method = 'POST';
  options.headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };

  var postReq = https.request(options, function(res) {
    var chunks = [];
    res.on('data', function(chunk) {
      return chunks.push(chunk);
    });
    res.on('end', function() {
      if (res.statusCode < 400) {
        return cb();
      }
      if (res.statusCode < 500) {
        console.error('Error posting message to Slack API: ' + res.statusCode + ' - ' + res.statusMessage);
        return cb();
      }
      return callback(new Error(res.statusMessage));
    });
  });

  postReq.write(body);
  postReq.end();
};

/*****************************************************************
* lambda
*****************************************************************/

exports.handler = function(event, context) {
  var d = domain.create();

  d.on('error', function (err) {
    console.error(err, err.stack);
    context.fail('Server error when processing message: ' + err);
  });

  async.waterfall([
    findMyLocation,
    function (myLocation, cb) {
      getNeighborsNotCaught({
        type: 'coords',
        coords: {
          latitude: myLocation.latitude,
          longitude: myLocation.longitude
        }
      }, cb)
    },
    function (pokemons, cb) {
      async.eachSeries(pokemons, function (pokemon, cb) {
        postPokemonToSlack(pokemon, cb);
      }, cb);
    }
  ], d.intercept(function () {
    context.succeed();
  }));
};
