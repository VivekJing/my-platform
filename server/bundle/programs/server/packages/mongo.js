(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var global = Package.meteor.global;
var meteorEnv = Package.meteor.meteorEnv;
var NpmModuleMongodb = Package['npm-mongo'].NpmModuleMongodb;
var NpmModuleMongodbVersion = Package['npm-mongo'].NpmModuleMongodbVersion;
var AllowDeny = Package['allow-deny'].AllowDeny;
var Random = Package.random.Random;
var EJSON = Package.ejson.EJSON;
var LocalCollection = Package.minimongo.LocalCollection;
var Minimongo = Package.minimongo.Minimongo;
var DDP = Package['ddp-client'].DDP;
var DDPServer = Package['ddp-server'].DDPServer;
var Tracker = Package.tracker.Tracker;
var Deps = Package.tracker.Deps;
var DiffSequence = Package['diff-sequence'].DiffSequence;
var MongoID = Package['mongo-id'].MongoID;
var check = Package.check.check;
var Match = Package.check.Match;
var ECMAScript = Package.ecmascript.ECMAScript;
var Decimal = Package['mongo-decimal'].Decimal;
var _ = Package.underscore._;
var MaxHeap = Package['binary-heap'].MaxHeap;
var MinHeap = Package['binary-heap'].MinHeap;
var MinMaxHeap = Package['binary-heap'].MinMaxHeap;
var Hook = Package['callback-hook'].Hook;
var meteorInstall = Package.modules.meteorInstall;
var Promise = Package.promise.Promise;

/* Package-scope variables */
var MongoInternals, MongoConnection, CursorDescription, Cursor, listenAll, forEachTrigger, OPLOG_COLLECTION, idForOp, OplogHandle, ObserveMultiplexer, ObserveHandle, PollingObserveDriver, OplogObserveDriver, Mongo, selector, callback, options;

var require = meteorInstall({"node_modules":{"meteor":{"mongo":{"mongo_driver.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/mongo_driver.js                                                                                      //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
!function (module1) {
  let DocFetcher;
  module1.link("./doc_fetcher.js", {
    DocFetcher(v) {
      DocFetcher = v;
    }

  }, 0);

  /**
   * Provide a synchronous Collection API using fibers, backed by
   * MongoDB.  This is only for use on the server, and mostly identical
   * to the client API.
   *
   * NOTE: the public API methods must be run within a fiber. If you call
   * these outside of a fiber they will explode!
   */
  var MongoDB = NpmModuleMongodb;

  var Future = Npm.require('fibers/future');

  MongoInternals = {};
  MongoInternals.NpmModules = {
    mongodb: {
      version: NpmModuleMongodbVersion,
      module: MongoDB
    }
  }; // Older version of what is now available via
  // MongoInternals.NpmModules.mongodb.module.  It was never documented, but
  // people do use it.
  // XXX COMPAT WITH 1.0.3.2

  MongoInternals.NpmModule = MongoDB; // This is used to add or remove EJSON from the beginning of everything nested
  // inside an EJSON custom type. It should only be called on pure JSON!

  var replaceNames = function (filter, thing) {
    if (typeof thing === "object" && thing !== null) {
      if (_.isArray(thing)) {
        return _.map(thing, _.bind(replaceNames, null, filter));
      }

      var ret = {};

      _.each(thing, function (value, key) {
        ret[filter(key)] = replaceNames(filter, value);
      });

      return ret;
    }

    return thing;
  }; // Ensure that EJSON.clone keeps a Timestamp as a Timestamp (instead of just
  // doing a structural clone).
  // XXX how ok is this? what if there are multiple copies of MongoDB loaded?


  MongoDB.Timestamp.prototype.clone = function () {
    // Timestamps should be immutable.
    return this;
  };

  var makeMongoLegal = function (name) {
    return "EJSON" + name;
  };

  var unmakeMongoLegal = function (name) {
    return name.substr(5);
  };

  var replaceMongoAtomWithMeteor = function (document) {
    if (document instanceof MongoDB.Binary) {
      var buffer = document.value(true);
      return new Uint8Array(buffer);
    }

    if (document instanceof MongoDB.ObjectID) {
      return new Mongo.ObjectID(document.toHexString());
    }

    if (document instanceof MongoDB.Decimal128) {
      return Decimal(document.toString());
    }

    if (document["EJSON$type"] && document["EJSON$value"] && _.size(document) === 2) {
      return EJSON.fromJSONValue(replaceNames(unmakeMongoLegal, document));
    }

    if (document instanceof MongoDB.Timestamp) {
      // For now, the Meteor representation of a Mongo timestamp type (not a date!
      // this is a weird internal thing used in the oplog!) is the same as the
      // Mongo representation. We need to do this explicitly or else we would do a
      // structural clone and lose the prototype.
      return document;
    }

    return undefined;
  };

  var replaceMeteorAtomWithMongo = function (document) {
    if (EJSON.isBinary(document)) {// This does more copies than we'd like, but is necessary because
      // MongoDB.BSON only looks like it takes a Uint8Array (and doesn't actually
      // serialize it correctly).
      // return new MongoDB.Binary(Buffer.from(document));
    }

    if (document instanceof Mongo.ObjectID) {
      return new MongoDB.ObjectID(document.toHexString());
    }

    if (document instanceof MongoDB.Timestamp) {
      // For now, the Meteor representation of a Mongo timestamp type (not a date!
      // this is a weird internal thing used in the oplog!) is the same as the
      // Mongo representation. We need to do this explicitly or else we would do a
      // structural clone and lose the prototype.
      return document;
    }

    if (document instanceof Decimal) {
      return MongoDB.Decimal128.fromString(document.toString());
    }

    if (EJSON._isCustomType(document)) {
      return replaceNames(makeMongoLegal, EJSON.toJSONValue(document));
    } // It is not ordinarily possible to stick dollar-sign keys into mongo
    // so we don't bother checking for things that need escaping at this time.


    return undefined;
  };

  var replaceTypes = function (document, atomTransformer) {
    if (typeof document !== 'object' || document === null) return document;
    var replacedTopLevelAtom = atomTransformer(document);
    if (replacedTopLevelAtom !== undefined) return replacedTopLevelAtom;
    var ret = document;

    _.each(document, function (val, key) {
      var valReplaced = replaceTypes(val, atomTransformer);

      if (val !== valReplaced) {
        // Lazy clone. Shallow copy.
        if (ret === document) ret = _.clone(document);
        ret[key] = valReplaced;
      }
    });

    return ret;
  };

  MongoConnection = function (url, options) {
    var self = this;
    options = options || {};
    self._observeMultiplexers = {};
    self._onFailoverHook = new Hook();
    var mongoOptions = Object.assign({
      // Reconnect on error.
      autoReconnect: true,
      // Try to reconnect forever, instead of stopping after 30 tries (the
      // default), with each attempt separated by 1000ms.
      reconnectTries: Infinity,
      ignoreUndefined: true,
      // Required to silence deprecation warnings with mongodb@3.1.1.
      useNewUrlParser: true
    }, Mongo._connectionOptions); // Disable the native parser by default, unless specifically enabled
    // in the mongo URL.
    // - The native driver can cause errors which normally would be
    //   thrown, caught, and handled into segfaults that take down the
    //   whole app.
    // - Binary modules don't yet work when you bundle and move the bundle
    //   to a different platform (aka deploy)
    // We should revisit this after binary npm module support lands.

    if (!/[\?&]native_?[pP]arser=/.test(url)) {
      mongoOptions.native_parser = false;
    } // Internally the oplog connections specify their own poolSize
    // which we don't want to overwrite with any user defined value


    if (_.has(options, 'poolSize')) {
      // If we just set this for "server", replSet will override it. If we just
      // set it for replSet, it will be ignored if we're not using a replSet.
      mongoOptions.poolSize = options.poolSize;
    }

    self.db = null; // We keep track of the ReplSet's primary, so that we can trigger hooks when
    // it changes.  The Node driver's joined callback seems to fire way too
    // often, which is why we need to track it ourselves.

    self._primary = null;
    self._oplogHandle = null;
    self._docFetcher = null;
    var connectFuture = new Future();
    MongoDB.connect(url, mongoOptions, Meteor.bindEnvironment(function (err, client) {
      if (err) {
        throw err;
      }

      var db = client.db(); // First, figure out what the current primary is, if any.

      if (db.serverConfig.isMasterDoc) {
        self._primary = db.serverConfig.isMasterDoc.primary;
      }

      db.serverConfig.on('joined', Meteor.bindEnvironment(function (kind, doc) {
        if (kind === 'primary') {
          if (doc.primary !== self._primary) {
            self._primary = doc.primary;

            self._onFailoverHook.each(function (callback) {
              callback();
              return true;
            });
          }
        } else if (doc.me === self._primary) {
          // The thing we thought was primary is now something other than
          // primary.  Forget that we thought it was primary.  (This means
          // that if a server stops being primary and then starts being
          // primary again without another server becoming primary in the
          // middle, we'll correctly count it as a failover.)
          self._primary = null;
        }
      })); // Allow the constructor to return.

      connectFuture['return']({
        client,
        db
      });
    }, connectFuture.resolver() // onException
    )); // Wait for the connection to be successful (throws on failure) and assign the
    // results (`client` and `db`) to `self`.

    Object.assign(self, connectFuture.wait());

    if (options.oplogUrl && !Package['disable-oplog']) {
      self._oplogHandle = new OplogHandle(options.oplogUrl, self.db.databaseName);
      self._docFetcher = new DocFetcher(self);
    }
  };

  MongoConnection.prototype.close = function () {
    var self = this;
    if (!self.db) throw Error("close called before Connection created?"); // XXX probably untested

    var oplogHandle = self._oplogHandle;
    self._oplogHandle = null;
    if (oplogHandle) oplogHandle.stop(); // Use Future.wrap so that errors get thrown. This happens to
    // work even outside a fiber since the 'close' method is not
    // actually asynchronous.

    Future.wrap(_.bind(self.client.close, self.client))(true).wait();
  }; // Returns the Mongo Collection object; may yield.


  MongoConnection.prototype.rawCollection = function (collectionName) {
    var self = this;
    if (!self.db) throw Error("rawCollection called before Connection created?");
    var future = new Future();
    self.db.collection(collectionName, future.resolver());
    return future.wait();
  };

  MongoConnection.prototype._createCappedCollection = function (collectionName, byteSize, maxDocuments) {
    var self = this;
    if (!self.db) throw Error("_createCappedCollection called before Connection created?");
    var future = new Future();
    self.db.createCollection(collectionName, {
      capped: true,
      size: byteSize,
      max: maxDocuments
    }, future.resolver());
    future.wait();
  }; // This should be called synchronously with a write, to create a
  // transaction on the current write fence, if any. After we can read
  // the write, and after observers have been notified (or at least,
  // after the observer notifiers have added themselves to the write
  // fence), you should call 'committed()' on the object returned.


  MongoConnection.prototype._maybeBeginWrite = function () {
    var fence = DDPServer._CurrentWriteFence.get();

    if (fence) {
      return fence.beginWrite();
    } else {
      return {
        committed: function () {}
      };
    }
  }; // Internal interface: adds a callback which is called when the Mongo primary
  // changes. Returns a stop handle.


  MongoConnection.prototype._onFailover = function (callback) {
    return this._onFailoverHook.register(callback);
  }; //////////// Public API //////////
  // The write methods block until the database has confirmed the write (it may
  // not be replicated or stable on disk, but one server has confirmed it) if no
  // callback is provided. If a callback is provided, then they call the callback
  // when the write is confirmed. They return nothing on success, and raise an
  // exception on failure.
  //
  // After making a write (with insert, update, remove), observers are
  // notified asynchronously. If you want to receive a callback once all
  // of the observer notifications have landed for your write, do the
  // writes inside a write fence (set DDPServer._CurrentWriteFence to a new
  // _WriteFence, and then set a callback on the write fence.)
  //
  // Since our execution environment is single-threaded, this is
  // well-defined -- a write "has been made" if it's returned, and an
  // observer "has been notified" if its callback has returned.


  var writeCallback = function (write, refresh, callback) {
    return function (err, result) {
      if (!err) {
        // XXX We don't have to run this on error, right?
        try {
          refresh();
        } catch (refreshErr) {
          if (callback) {
            callback(refreshErr);
            return;
          } else {
            throw refreshErr;
          }
        }
      }

      write.committed();

      if (callback) {
        callback(err, result);
      } else if (err) {
        throw err;
      }
    };
  };

  var bindEnvironmentForWrite = function (callback) {
    return Meteor.bindEnvironment(callback, "Mongo write");
  };

  MongoConnection.prototype._insert = function (collection_name, document, callback) {
    var self = this;

    var sendError = function (e) {
      if (callback) return callback(e);
      throw e;
    };

    if (collection_name === "___meteor_failure_test_collection") {
      var e = new Error("Failure test");
      e._expectedByTest = true;
      sendError(e);
      return;
    }

    if (!(LocalCollection._isPlainObject(document) && !EJSON._isCustomType(document))) {
      sendError(new Error("Only plain objects may be inserted into MongoDB"));
      return;
    }

    var write = self._maybeBeginWrite();

    var refresh = function () {
      Meteor.refresh({
        collection: collection_name,
        id: document._id
      });
    };

    callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));

    try {
      var collection = self.rawCollection(collection_name);
      collection.insert(replaceTypes(document, replaceMeteorAtomWithMongo), {
        safe: true
      }, callback);
    } catch (err) {
      write.committed();
      throw err;
    }
  }; // Cause queries that may be affected by the selector to poll in this write
  // fence.


  MongoConnection.prototype._refresh = function (collectionName, selector) {
    var refreshKey = {
      collection: collectionName
    }; // If we know which documents we're removing, don't poll queries that are
    // specific to other documents. (Note that multiple notifications here should
    // not cause multiple polls, since all our listener is doing is enqueueing a
    // poll.)

    var specificIds = LocalCollection._idsMatchedBySelector(selector);

    if (specificIds) {
      _.each(specificIds, function (id) {
        Meteor.refresh(_.extend({
          id: id
        }, refreshKey));
      });
    } else {
      Meteor.refresh(refreshKey);
    }
  };

  MongoConnection.prototype._remove = function (collection_name, selector, callback) {
    var self = this;

    if (collection_name === "___meteor_failure_test_collection") {
      var e = new Error("Failure test");
      e._expectedByTest = true;

      if (callback) {
        return callback(e);
      } else {
        throw e;
      }
    }

    var write = self._maybeBeginWrite();

    var refresh = function () {
      self._refresh(collection_name, selector);
    };

    callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));

    try {
      var collection = self.rawCollection(collection_name);

      var wrappedCallback = function (err, driverResult) {
        callback(err, transformResult(driverResult).numberAffected);
      };

      collection.remove(replaceTypes(selector, replaceMeteorAtomWithMongo), {
        safe: true
      }, wrappedCallback);
    } catch (err) {
      write.committed();
      throw err;
    }
  };

  MongoConnection.prototype._dropCollection = function (collectionName, cb) {
    var self = this;

    var write = self._maybeBeginWrite();

    var refresh = function () {
      Meteor.refresh({
        collection: collectionName,
        id: null,
        dropCollection: true
      });
    };

    cb = bindEnvironmentForWrite(writeCallback(write, refresh, cb));

    try {
      var collection = self.rawCollection(collectionName);
      collection.drop(cb);
    } catch (e) {
      write.committed();
      throw e;
    }
  }; // For testing only.  Slightly better than `c.rawDatabase().dropDatabase()`
  // because it lets the test's fence wait for it to be complete.


  MongoConnection.prototype._dropDatabase = function (cb) {
    var self = this;

    var write = self._maybeBeginWrite();

    var refresh = function () {
      Meteor.refresh({
        dropDatabase: true
      });
    };

    cb = bindEnvironmentForWrite(writeCallback(write, refresh, cb));

    try {
      self.db.dropDatabase(cb);
    } catch (e) {
      write.committed();
      throw e;
    }
  };

  MongoConnection.prototype._update = function (collection_name, selector, mod, options, callback) {
    var self = this;

    if (!callback && options instanceof Function) {
      callback = options;
      options = null;
    }

    if (collection_name === "___meteor_failure_test_collection") {
      var e = new Error("Failure test");
      e._expectedByTest = true;

      if (callback) {
        return callback(e);
      } else {
        throw e;
      }
    } // explicit safety check. null and undefined can crash the mongo
    // driver. Although the node driver and minimongo do 'support'
    // non-object modifier in that they don't crash, they are not
    // meaningful operations and do not do anything. Defensively throw an
    // error here.


    if (!mod || typeof mod !== 'object') throw new Error("Invalid modifier. Modifier must be an object.");

    if (!(LocalCollection._isPlainObject(mod) && !EJSON._isCustomType(mod))) {
      throw new Error("Only plain objects may be used as replacement" + " documents in MongoDB");
    }

    if (!options) options = {};

    var write = self._maybeBeginWrite();

    var refresh = function () {
      self._refresh(collection_name, selector);
    };

    callback = writeCallback(write, refresh, callback);

    try {
      var collection = self.rawCollection(collection_name);
      var mongoOpts = {
        safe: true
      }; // explictly enumerate options that minimongo supports

      if (options.upsert) mongoOpts.upsert = true;
      if (options.multi) mongoOpts.multi = true; // Lets you get a more more full result from MongoDB. Use with caution:
      // might not work with C.upsert (as opposed to C.update({upsert:true}) or
      // with simulated upsert.

      if (options.fullResult) mongoOpts.fullResult = true;
      var mongoSelector = replaceTypes(selector, replaceMeteorAtomWithMongo);
      var mongoMod = replaceTypes(mod, replaceMeteorAtomWithMongo);

      var isModify = LocalCollection._isModificationMod(mongoMod);

      if (options._forbidReplace && !isModify) {
        var err = new Error("Invalid modifier. Replacements are forbidden.");

        if (callback) {
          return callback(err);
        } else {
          throw err;
        }
      } // We've already run replaceTypes/replaceMeteorAtomWithMongo on
      // selector and mod.  We assume it doesn't matter, as far as
      // the behavior of modifiers is concerned, whether `_modify`
      // is run on EJSON or on mongo-converted EJSON.
      // Run this code up front so that it fails fast if someone uses
      // a Mongo update operator we don't support.


      let knownId;

      if (options.upsert) {
        try {
          let newDoc = LocalCollection._createUpsertDocument(selector, mod);

          knownId = newDoc._id;
        } catch (err) {
          if (callback) {
            return callback(err);
          } else {
            throw err;
          }
        }
      }

      if (options.upsert && !isModify && !knownId && options.insertedId && !(options.insertedId instanceof Mongo.ObjectID && options.generatedId)) {
        // In case of an upsert with a replacement, where there is no _id defined
        // in either the query or the replacement doc, mongo will generate an id itself.
        // Therefore we need this special strategy if we want to control the id ourselves.
        // We don't need to do this when:
        // - This is not a replacement, so we can add an _id to $setOnInsert
        // - The id is defined by query or mod we can just add it to the replacement doc
        // - The user did not specify any id preference and the id is a Mongo ObjectId,
        //     then we can just let Mongo generate the id
        simulateUpsertWithInsertedId(collection, mongoSelector, mongoMod, options, // This callback does not need to be bindEnvironment'ed because
        // simulateUpsertWithInsertedId() wraps it and then passes it through
        // bindEnvironmentForWrite.
        function (error, result) {
          // If we got here via a upsert() call, then options._returnObject will
          // be set and we should return the whole object. Otherwise, we should
          // just return the number of affected docs to match the mongo API.
          if (result && !options._returnObject) {
            callback(error, result.numberAffected);
          } else {
            callback(error, result);
          }
        });
      } else {
        if (options.upsert && !knownId && options.insertedId && isModify) {
          if (!mongoMod.hasOwnProperty('$setOnInsert')) {
            mongoMod.$setOnInsert = {};
          }

          knownId = options.insertedId;
          Object.assign(mongoMod.$setOnInsert, replaceTypes({
            _id: options.insertedId
          }, replaceMeteorAtomWithMongo));
        }

        collection.update(mongoSelector, mongoMod, mongoOpts, bindEnvironmentForWrite(function (err, result) {
          if (!err) {
            var meteorResult = transformResult(result);

            if (meteorResult && options._returnObject) {
              // If this was an upsert() call, and we ended up
              // inserting a new doc and we know its id, then
              // return that id as well.
              if (options.upsert && meteorResult.insertedId) {
                if (knownId) {
                  meteorResult.insertedId = knownId;
                } else if (meteorResult.insertedId instanceof MongoDB.ObjectID) {
                  meteorResult.insertedId = new Mongo.ObjectID(meteorResult.insertedId.toHexString());
                }
              }

              callback(err, meteorResult);
            } else {
              callback(err, meteorResult.numberAffected);
            }
          } else {
            callback(err);
          }
        }));
      }
    } catch (e) {
      write.committed();
      throw e;
    }
  };

  var transformResult = function (driverResult) {
    var meteorResult = {
      numberAffected: 0
    };

    if (driverResult) {
      var mongoResult = driverResult.result; // On updates with upsert:true, the inserted values come as a list of
      // upserted values -- even with options.multi, when the upsert does insert,
      // it only inserts one element.

      if (mongoResult.upserted) {
        meteorResult.numberAffected += mongoResult.upserted.length;

        if (mongoResult.upserted.length == 1) {
          meteorResult.insertedId = mongoResult.upserted[0]._id;
        }
      } else {
        meteorResult.numberAffected = mongoResult.n;
      }
    }

    return meteorResult;
  };

  var NUM_OPTIMISTIC_TRIES = 3; // exposed for testing

  MongoConnection._isCannotChangeIdError = function (err) {
    // Mongo 3.2.* returns error as next Object:
    // {name: String, code: Number, errmsg: String}
    // Older Mongo returns:
    // {name: String, code: Number, err: String}
    var error = err.errmsg || err.err; // We don't use the error code here
    // because the error code we observed it producing (16837) appears to be
    // a far more generic error code based on examining the source.

    if (error.indexOf('The _id field cannot be changed') === 0 || error.indexOf("the (immutable) field '_id' was found to have been altered to _id") !== -1) {
      return true;
    }

    return false;
  };

  var simulateUpsertWithInsertedId = function (collection, selector, mod, options, callback) {
    // STRATEGY: First try doing an upsert with a generated ID.
    // If this throws an error about changing the ID on an existing document
    // then without affecting the database, we know we should probably try
    // an update without the generated ID. If it affected 0 documents,
    // then without affecting the database, we the document that first
    // gave the error is probably removed and we need to try an insert again
    // We go back to step one and repeat.
    // Like all "optimistic write" schemes, we rely on the fact that it's
    // unlikely our writes will continue to be interfered with under normal
    // circumstances (though sufficiently heavy contention with writers
    // disagreeing on the existence of an object will cause writes to fail
    // in theory).
    var insertedId = options.insertedId; // must exist

    var mongoOptsForUpdate = {
      safe: true,
      multi: options.multi
    };
    var mongoOptsForInsert = {
      safe: true,
      upsert: true
    };
    var replacementWithId = Object.assign(replaceTypes({
      _id: insertedId
    }, replaceMeteorAtomWithMongo), mod);
    var tries = NUM_OPTIMISTIC_TRIES;

    var doUpdate = function () {
      tries--;

      if (!tries) {
        callback(new Error("Upsert failed after " + NUM_OPTIMISTIC_TRIES + " tries."));
      } else {
        collection.update(selector, mod, mongoOptsForUpdate, bindEnvironmentForWrite(function (err, result) {
          if (err) {
            callback(err);
          } else if (result && result.result.n != 0) {
            callback(null, {
              numberAffected: result.result.n
            });
          } else {
            doConditionalInsert();
          }
        }));
      }
    };

    var doConditionalInsert = function () {
      collection.update(selector, replacementWithId, mongoOptsForInsert, bindEnvironmentForWrite(function (err, result) {
        if (err) {
          // figure out if this is a
          // "cannot change _id of document" error, and
          // if so, try doUpdate() again, up to 3 times.
          if (MongoConnection._isCannotChangeIdError(err)) {
            doUpdate();
          } else {
            callback(err);
          }
        } else {
          callback(null, {
            numberAffected: result.result.upserted.length,
            insertedId: insertedId
          });
        }
      }));
    };

    doUpdate();
  };

  _.each(["insert", "update", "remove", "dropCollection", "dropDatabase"], function (method) {
    MongoConnection.prototype[method] = function ()
    /* arguments */
    {
      var self = this;
      return Meteor.wrapAsync(self["_" + method]).apply(self, arguments);
    };
  }); // XXX MongoConnection.upsert() does not return the id of the inserted document
  // unless you set it explicitly in the selector or modifier (as a replacement
  // doc).


  MongoConnection.prototype.upsert = function (collectionName, selector, mod, options, callback) {
    var self = this;

    if (typeof options === "function" && !callback) {
      callback = options;
      options = {};
    }

    return self.update(collectionName, selector, mod, _.extend({}, options, {
      upsert: true,
      _returnObject: true
    }), callback);
  };

  MongoConnection.prototype.find = function (collectionName, selector, options) {
    var self = this;
    if (arguments.length === 1) selector = {};
    return new Cursor(self, new CursorDescription(collectionName, selector, options));
  };

  MongoConnection.prototype.findOne = function (collection_name, selector, options) {
    var self = this;
    if (arguments.length === 1) selector = {};
    options = options || {};
    options.limit = 1;
    return self.find(collection_name, selector, options).fetch()[0];
  }; // We'll actually design an index API later. For now, we just pass through to
  // Mongo's, but make it synchronous.


  MongoConnection.prototype._ensureIndex = function (collectionName, index, options) {
    try {
      var self = this; // We expect this function to be called at startup, not from within a method,
      // so we don't interact with the write fence.

      var collection = self.rawCollection(collectionName);
      var future = new Future();
      var indexName = collection.ensureIndex(index, options, future.resolver());
      future.wait();
    } catch (Exception) {}
  };

  MongoConnection.prototype._dropIndex = function (collectionName, index) {
    var self = this; // This function is only used by test code, not within a method, so we don't
    // interact with the write fence.

    var collection = self.rawCollection(collectionName);
    var future = new Future();
    var indexName = collection.dropIndex(index, future.resolver());
    future.wait();
  }; // CURSORS
  // There are several classes which relate to cursors:
  //
  // CursorDescription represents the arguments used to construct a cursor:
  // collectionName, selector, and (find) options.  Because it is used as a key
  // for cursor de-dup, everything in it should either be JSON-stringifiable or
  // not affect observeChanges output (eg, options.transform functions are not
  // stringifiable but do not affect observeChanges).
  //
  // SynchronousCursor is a wrapper around a MongoDB cursor
  // which includes fully-synchronous versions of forEach, etc.
  //
  // Cursor is the cursor object returned from find(), which implements the
  // documented Mongo.Collection cursor API.  It wraps a CursorDescription and a
  // SynchronousCursor (lazily: it doesn't contact Mongo until you call a method
  // like fetch or forEach on it).
  //
  // ObserveHandle is the "observe handle" returned from observeChanges. It has a
  // reference to an ObserveMultiplexer.
  //
  // ObserveMultiplexer allows multiple identical ObserveHandles to be driven by a
  // single observe driver.
  //
  // There are two "observe drivers" which drive ObserveMultiplexers:
  //   - PollingObserveDriver caches the results of a query and reruns it when
  //     necessary.
  //   - OplogObserveDriver follows the Mongo operation log to directly observe
  //     database changes.
  // Both implementations follow the same simple interface: when you create them,
  // they start sending observeChanges callbacks (and a ready() invocation) to
  // their ObserveMultiplexer, and you stop them by calling their stop() method.


  CursorDescription = function (collectionName, selector, options) {
    var self = this;
    self.collectionName = collectionName;
    self.selector = Mongo.Collection._rewriteSelector(selector);
    self.options = options || {};
  };

  Cursor = function (mongo, cursorDescription) {
    var self = this;
    self._mongo = mongo;
    self._cursorDescription = cursorDescription;
    self._synchronousCursor = null;
  };

  _.each(['forEach', 'map', 'fetch', 'count', Symbol.iterator], function (method) {
    Cursor.prototype[method] = function () {
      var self = this; // You can only observe a tailable cursor.

      if (self._cursorDescription.options.tailable) throw new Error("Cannot call " + method + " on a tailable cursor");

      if (!self._synchronousCursor) {
        self._synchronousCursor = self._mongo._createSynchronousCursor(self._cursorDescription, {
          // Make sure that the "self" argument to forEach/map callbacks is the
          // Cursor, not the SynchronousCursor.
          selfForIteration: self,
          useTransform: true
        });
      }

      return self._synchronousCursor[method].apply(self._synchronousCursor, arguments);
    };
  }); // Since we don't actually have a "nextObject" interface, there's really no
  // reason to have a "rewind" interface.  All it did was make multiple calls
  // to fetch/map/forEach return nothing the second time.
  // XXX COMPAT WITH 0.8.1


  Cursor.prototype.rewind = function () {};

  Cursor.prototype.getTransform = function () {
    return this._cursorDescription.options.transform;
  }; // When you call Meteor.publish() with a function that returns a Cursor, we need
  // to transmute it into the equivalent subscription.  This is the function that
  // does that.


  Cursor.prototype._publishCursor = function (sub) {
    var self = this;
    var collection = self._cursorDescription.collectionName;
    return Mongo.Collection._publishCursor(self, sub, collection);
  }; // Used to guarantee that publish functions return at most one cursor per
  // collection. Private, because we might later have cursors that include
  // documents from multiple collections somehow.


  Cursor.prototype._getCollectionName = function () {
    var self = this;
    return self._cursorDescription.collectionName;
  };

  Cursor.prototype.observe = function (callbacks) {
    var self = this;
    return LocalCollection._observeFromObserveChanges(self, callbacks);
  };

  Cursor.prototype.observeChanges = function (callbacks) {
    var self = this;
    var methods = ['addedAt', 'added', 'changedAt', 'changed', 'removedAt', 'removed', 'movedTo'];

    var ordered = LocalCollection._observeChangesCallbacksAreOrdered(callbacks); // XXX: Can we find out if callbacks are from observe?


    var exceptionName = ' observe/observeChanges callback';
    methods.forEach(function (method) {
      if (callbacks[method] && typeof callbacks[method] == "function") {
        callbacks[method] = Meteor.bindEnvironment(callbacks[method], method + exceptionName);
      }
    });
    return self._mongo._observeChanges(self._cursorDescription, ordered, callbacks);
  };

  MongoConnection.prototype._createSynchronousCursor = function (cursorDescription, options) {
    var self = this;
    options = _.pick(options || {}, 'selfForIteration', 'useTransform');
    var collection = self.rawCollection(cursorDescription.collectionName);
    var cursorOptions = cursorDescription.options;
    var mongoOptions = {
      sort: cursorOptions.sort,
      limit: cursorOptions.limit,
      skip: cursorOptions.skip,
      projection: cursorOptions.fields
    }; // Do we want a tailable cursor (which only works on capped collections)?

    if (cursorOptions.tailable) {
      // We want a tailable cursor...
      mongoOptions.tailable = true; // ... and for the server to wait a bit if any getMore has no data (rather
      // than making us put the relevant sleeps in the client)...

      mongoOptions.awaitdata = true; // ... and to keep querying the server indefinitely rather than just 5 times
      // if there's no more data.

      mongoOptions.numberOfRetries = -1; // And if this is on the oplog collection and the cursor specifies a 'ts',
      // then set the undocumented oplog replay flag, which does a special scan to
      // find the first document (instead of creating an index on ts). This is a
      // very hard-coded Mongo flag which only works on the oplog collection and
      // only works with the ts field.

      if (cursorDescription.collectionName === OPLOG_COLLECTION && cursorDescription.selector.ts) {
        mongoOptions.oplogReplay = true;
      }
    }

    var dbCursor = collection.find(replaceTypes(cursorDescription.selector, replaceMeteorAtomWithMongo), mongoOptions);

    if (typeof cursorOptions.maxTimeMs !== 'undefined') {
      dbCursor = dbCursor.maxTimeMS(cursorOptions.maxTimeMs);
    }

    if (typeof cursorOptions.hint !== 'undefined') {
      dbCursor = dbCursor.hint(cursorOptions.hint);
    }

    return new SynchronousCursor(dbCursor, cursorDescription, options);
  };

  var SynchronousCursor = function (dbCursor, cursorDescription, options) {
    var self = this;
    options = _.pick(options || {}, 'selfForIteration', 'useTransform');
    self._dbCursor = dbCursor;
    self._cursorDescription = cursorDescription; // The "self" argument passed to forEach/map callbacks. If we're wrapped
    // inside a user-visible Cursor, we want to provide the outer cursor!

    self._selfForIteration = options.selfForIteration || self;

    if (options.useTransform && cursorDescription.options.transform) {
      self._transform = LocalCollection.wrapTransform(cursorDescription.options.transform);
    } else {
      self._transform = null;
    }

    self._synchronousCount = Future.wrap(dbCursor.count.bind(dbCursor));
    self._visitedIds = new LocalCollection._IdMap();
  };

  _.extend(SynchronousCursor.prototype, {
    // Returns a Promise for the next object from the underlying cursor (before
    // the Mongo->Meteor type replacement).
    _rawNextObjectPromise: function () {
      const self = this;
      return new Promise((resolve, reject) => {
        self._dbCursor.next((err, doc) => {
          if (err) {
            reject(err);
          } else {
            resolve(doc);
          }
        });
      });
    },
    // Returns a Promise for the next object from the cursor, skipping those whose
    // IDs we've already seen and replacing Mongo atoms with Meteor atoms.
    _nextObjectPromise: function () {
      return Promise.asyncApply(() => {
        var self = this;

        while (true) {
          var doc = Promise.await(self._rawNextObjectPromise());
          if (!doc) return null;
          doc = replaceTypes(doc, replaceMongoAtomWithMeteor);

          if (!self._cursorDescription.options.tailable && _.has(doc, '_id')) {
            // Did Mongo give us duplicate documents in the same cursor? If so,
            // ignore this one. (Do this before the transform, since transform might
            // return some unrelated value.) We don't do this for tailable cursors,
            // because we want to maintain O(1) memory usage. And if there isn't _id
            // for some reason (maybe it's the oplog), then we don't do this either.
            // (Be careful to do this for falsey but existing _id, though.)
            if (self._visitedIds.has(doc._id)) continue;

            self._visitedIds.set(doc._id, true);
          }

          if (self._transform) doc = self._transform(doc);
          return doc;
        }
      });
    },
    // Returns a promise which is resolved with the next object (like with
    // _nextObjectPromise) or rejected if the cursor doesn't return within
    // timeoutMS ms.
    _nextObjectPromiseWithTimeout: function (timeoutMS) {
      const self = this;

      if (!timeoutMS) {
        return self._nextObjectPromise();
      }

      const nextObjectPromise = self._nextObjectPromise();

      const timeoutErr = new Error('Client-side timeout waiting for next object');
      const timeoutPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(timeoutErr);
        }, timeoutMS);
      });
      return Promise.race([nextObjectPromise, timeoutPromise]).catch(err => {
        if (err === timeoutErr) {
          self.close();
        }

        throw err;
      });
    },
    _nextObject: function () {
      var self = this;
      return self._nextObjectPromise().await();
    },
    forEach: function (callback, thisArg) {
      var self = this; // Get back to the beginning.

      self._rewind(); // We implement the loop ourself instead of using self._dbCursor.each,
      // because "each" will call its callback outside of a fiber which makes it
      // much more complex to make this function synchronous.


      var index = 0;

      while (true) {
        var doc = self._nextObject();

        if (!doc) return;
        callback.call(thisArg, doc, index++, self._selfForIteration);
      }
    },
    // XXX Allow overlapping callback executions if callback yields.
    map: function (callback, thisArg) {
      var self = this;
      var res = [];
      self.forEach(function (doc, index) {
        res.push(callback.call(thisArg, doc, index, self._selfForIteration));
      });
      return res;
    },
    _rewind: function () {
      var self = this; // known to be synchronous

      self._dbCursor.rewind();

      self._visitedIds = new LocalCollection._IdMap();
    },
    // Mostly usable for tailable cursors.
    close: function () {
      var self = this;

      self._dbCursor.close();
    },
    fetch: function () {
      var self = this;
      return self.map(_.identity);
    },
    count: function () {
      let applySkipLimit = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : false;
      var self = this;
      return self._synchronousCount(applySkipLimit).wait();
    },
    // This method is NOT wrapped in Cursor.
    getRawObjects: function (ordered) {
      var self = this;

      if (ordered) {
        return self.fetch();
      } else {
        var results = new LocalCollection._IdMap();
        self.forEach(function (doc) {
          results.set(doc._id, doc);
        });
        return results;
      }
    }
  });

  SynchronousCursor.prototype[Symbol.iterator] = function () {
    var self = this; // Get back to the beginning.

    self._rewind();

    return {
      next() {
        const doc = self._nextObject();

        return doc ? {
          value: doc
        } : {
          done: true
        };
      }

    };
  }; // Tails the cursor described by cursorDescription, most likely on the
  // oplog. Calls docCallback with each document found. Ignores errors and just
  // restarts the tail on error.
  //
  // If timeoutMS is set, then if we don't get a new document every timeoutMS,
  // kill and restart the cursor. This is primarily a workaround for #8598.


  MongoConnection.prototype.tail = function (cursorDescription, docCallback, timeoutMS) {
    var self = this;
    if (!cursorDescription.options.tailable) throw new Error("Can only tail a tailable cursor");

    var cursor = self._createSynchronousCursor(cursorDescription);

    var stopped = false;
    var lastTS;

    var loop = function () {
      var doc = null;

      while (true) {
        if (stopped) return;

        try {
          doc = cursor._nextObjectPromiseWithTimeout(timeoutMS).await();
        } catch (err) {
          // There's no good way to figure out if this was actually an error from
          // Mongo, or just client-side (including our own timeout error). Ah
          // well. But either way, we need to retry the cursor (unless the failure
          // was because the observe got stopped).
          doc = null;
        } // Since we awaited a promise above, we need to check again to see if
        // we've been stopped before calling the callback.


        if (stopped) return;

        if (doc) {
          // If a tailable cursor contains a "ts" field, use it to recreate the
          // cursor on error. ("ts" is a standard that Mongo uses internally for
          // the oplog, and there's a special flag that lets you do binary search
          // on it instead of needing to use an index.)
          lastTS = doc.ts;
          docCallback(doc);
        } else {
          var newSelector = _.clone(cursorDescription.selector);

          if (lastTS) {
            newSelector.ts = {
              $gt: lastTS
            };
          }

          cursor = self._createSynchronousCursor(new CursorDescription(cursorDescription.collectionName, newSelector, cursorDescription.options)); // Mongo failover takes many seconds.  Retry in a bit.  (Without this
          // setTimeout, we peg the CPU at 100% and never notice the actual
          // failover.

          Meteor.setTimeout(loop, 100);
          break;
        }
      }
    };

    Meteor.defer(loop);
    return {
      stop: function () {
        stopped = true;
        cursor.close();
      }
    };
  };

  MongoConnection.prototype._observeChanges = function (cursorDescription, ordered, callbacks) {
    var self = this;

    if (cursorDescription.options.tailable) {
      return self._observeChangesTailable(cursorDescription, ordered, callbacks);
    } // You may not filter out _id when observing changes, because the id is a core
    // part of the observeChanges API.


    if (cursorDescription.options.fields && (cursorDescription.options.fields._id === 0 || cursorDescription.options.fields._id === false)) {
      throw Error("You may not observe a cursor with {fields: {_id: 0}}");
    }

    var observeKey = EJSON.stringify(_.extend({
      ordered: ordered
    }, cursorDescription));
    var multiplexer, observeDriver;
    var firstHandle = false; // Find a matching ObserveMultiplexer, or create a new one. This next block is
    // guaranteed to not yield (and it doesn't call anything that can observe a
    // new query), so no other calls to this function can interleave with it.

    Meteor._noYieldsAllowed(function () {
      if (_.has(self._observeMultiplexers, observeKey)) {
        multiplexer = self._observeMultiplexers[observeKey];
      } else {
        firstHandle = true; // Create a new ObserveMultiplexer.

        multiplexer = new ObserveMultiplexer({
          ordered: ordered,
          onStop: function () {
            delete self._observeMultiplexers[observeKey];
            observeDriver.stop();
          }
        });
        self._observeMultiplexers[observeKey] = multiplexer;
      }
    });

    var observeHandle = new ObserveHandle(multiplexer, callbacks);

    if (firstHandle) {
      var matcher, sorter;

      var canUseOplog = _.all([function () {
        // At a bare minimum, using the oplog requires us to have an oplog, to
        // want unordered callbacks, and to not want a callback on the polls
        // that won't happen.
        return self._oplogHandle && !ordered && !callbacks._testOnlyPollCallback;
      }, function () {
        // We need to be able to compile the selector. Fall back to polling for
        // some newfangled $selector that minimongo doesn't support yet.
        try {
          matcher = new Minimongo.Matcher(cursorDescription.selector);
          return true;
        } catch (e) {
          // XXX make all compilation errors MinimongoError or something
          //     so that this doesn't ignore unrelated exceptions
          return false;
        }
      }, function () {
        // ... and the selector itself needs to support oplog.
        return OplogObserveDriver.cursorSupported(cursorDescription, matcher);
      }, function () {
        // And we need to be able to compile the sort, if any.  eg, can't be
        // {$natural: 1}.
        if (!cursorDescription.options.sort) return true;

        try {
          sorter = new Minimongo.Sorter(cursorDescription.options.sort);
          return true;
        } catch (e) {
          // XXX make all compilation errors MinimongoError or something
          //     so that this doesn't ignore unrelated exceptions
          return false;
        }
      }], function (f) {
        return f();
      }); // invoke each function


      var driverClass = canUseOplog ? OplogObserveDriver : PollingObserveDriver;
      observeDriver = new driverClass({
        cursorDescription: cursorDescription,
        mongoHandle: self,
        multiplexer: multiplexer,
        ordered: ordered,
        matcher: matcher,
        // ignored by polling
        sorter: sorter,
        // ignored by polling
        _testOnlyPollCallback: callbacks._testOnlyPollCallback
      }); // This field is only set for use in tests.

      multiplexer._observeDriver = observeDriver;
    } // Blocks until the initial adds have been sent.


    multiplexer.addHandleAndSendInitialAdds(observeHandle);
    return observeHandle;
  }; // Listen for the invalidation messages that will trigger us to poll the
  // database for changes. If this selector specifies specific IDs, specify them
  // here, so that updates to different specific IDs don't cause us to poll.
  // listenCallback is the same kind of (notification, complete) callback passed
  // to InvalidationCrossbar.listen.


  listenAll = function (cursorDescription, listenCallback) {
    var listeners = [];
    forEachTrigger(cursorDescription, function (trigger) {
      listeners.push(DDPServer._InvalidationCrossbar.listen(trigger, listenCallback));
    });
    return {
      stop: function () {
        _.each(listeners, function (listener) {
          listener.stop();
        });
      }
    };
  };

  forEachTrigger = function (cursorDescription, triggerCallback) {
    var key = {
      collection: cursorDescription.collectionName
    };

    var specificIds = LocalCollection._idsMatchedBySelector(cursorDescription.selector);

    if (specificIds) {
      _.each(specificIds, function (id) {
        triggerCallback(_.extend({
          id: id
        }, key));
      });

      triggerCallback(_.extend({
        dropCollection: true,
        id: null
      }, key));
    } else {
      triggerCallback(key);
    } // Everyone cares about the database being dropped.


    triggerCallback({
      dropDatabase: true
    });
  }; // observeChanges for tailable cursors on capped collections.
  //
  // Some differences from normal cursors:
  //   - Will never produce anything other than 'added' or 'addedBefore'. If you
  //     do update a document that has already been produced, this will not notice
  //     it.
  //   - If you disconnect and reconnect from Mongo, it will essentially restart
  //     the query, which will lead to duplicate results. This is pretty bad,
  //     but if you include a field called 'ts' which is inserted as
  //     new MongoInternals.MongoTimestamp(0, 0) (which is initialized to the
  //     current Mongo-style timestamp), we'll be able to find the place to
  //     restart properly. (This field is specifically understood by Mongo with an
  //     optimization which allows it to find the right place to start without
  //     an index on ts. It's how the oplog works.)
  //   - No callbacks are triggered synchronously with the call (there's no
  //     differentiation between "initial data" and "later changes"; everything
  //     that matches the query gets sent asynchronously).
  //   - De-duplication is not implemented.
  //   - Does not yet interact with the write fence. Probably, this should work by
  //     ignoring removes (which don't work on capped collections) and updates
  //     (which don't affect tailable cursors), and just keeping track of the ID
  //     of the inserted object, and closing the write fence once you get to that
  //     ID (or timestamp?).  This doesn't work well if the document doesn't match
  //     the query, though.  On the other hand, the write fence can close
  //     immediately if it does not match the query. So if we trust minimongo
  //     enough to accurately evaluate the query against the write fence, we
  //     should be able to do this...  Of course, minimongo doesn't even support
  //     Mongo Timestamps yet.


  MongoConnection.prototype._observeChangesTailable = function (cursorDescription, ordered, callbacks) {
    var self = this; // Tailable cursors only ever call added/addedBefore callbacks, so it's an
    // error if you didn't provide them.

    if (ordered && !callbacks.addedBefore || !ordered && !callbacks.added) {
      throw new Error("Can't observe an " + (ordered ? "ordered" : "unordered") + " tailable cursor without a " + (ordered ? "addedBefore" : "added") + " callback");
    }

    return self.tail(cursorDescription, function (doc) {
      var id = doc._id;
      delete doc._id; // The ts is an implementation detail. Hide it.

      delete doc.ts;

      if (ordered) {
        callbacks.addedBefore(id, doc, null);
      } else {
        callbacks.added(id, doc);
      }
    });
  }; // XXX We probably need to find a better way to expose this. Right now
  // it's only used by tests, but in fact you need it in normal
  // operation to interact with capped collections.


  MongoInternals.MongoTimestamp = MongoDB.Timestamp;
  MongoInternals.Connection = MongoConnection;
}.call(this, module);
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"oplog_tailing.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/oplog_tailing.js                                                                                     //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
let NpmModuleMongodb;
module.link("meteor/npm-mongo", {
  NpmModuleMongodb(v) {
    NpmModuleMongodb = v;
  }

}, 0);

var Future = Npm.require('fibers/future');

const {
  Timestamp
} = NpmModuleMongodb;
OPLOG_COLLECTION = 'oplog.rs';
var TOO_FAR_BEHIND = process.env.METEOR_OPLOG_TOO_FAR_BEHIND || 2000;
var TAIL_TIMEOUT = +process.env.METEOR_OPLOG_TAIL_TIMEOUT || 30000;

var showTS = function (ts) {
  return "Timestamp(" + ts.getHighBits() + ", " + ts.getLowBits() + ")";
};

idForOp = function (op) {
  if (op.op === 'd') return op.o._id;else if (op.op === 'i') return op.o._id;else if (op.op === 'u') return op.o2._id;else if (op.op === 'c') throw Error("Operator 'c' doesn't supply an object with id: " + EJSON.stringify(op));else throw Error("Unknown op: " + EJSON.stringify(op));
};

OplogHandle = function (oplogUrl, dbName) {
  var self = this;
  self._oplogUrl = oplogUrl;
  self._dbName = dbName;
  self._oplogLastEntryConnection = null;
  self._oplogTailConnection = null;
  self._stopped = false;
  self._tailHandle = null;
  self._readyFuture = new Future();
  self._crossbar = new DDPServer._Crossbar({
    factPackage: "mongo-livedata",
    factName: "oplog-watchers"
  });
  self._baseOplogSelector = {
    ns: new RegExp("^(?:" + [Meteor._escapeRegExp(self._dbName + "."), Meteor._escapeRegExp("admin.$cmd")].join("|") + ")"),
    $or: [{
      op: {
        $in: ['i', 'u', 'd']
      }
    }, // drop collection
    {
      op: 'c',
      'o.drop': {
        $exists: true
      }
    }, {
      op: 'c',
      'o.dropDatabase': 1
    }, {
      op: 'c',
      'o.applyOps': {
        $exists: true
      }
    }]
  }; // Data structures to support waitUntilCaughtUp(). Each oplog entry has a
  // MongoTimestamp object on it (which is not the same as a Date --- it's a
  // combination of time and an incrementing counter; see
  // http://docs.mongodb.org/manual/reference/bson-types/#timestamps).
  //
  // _catchingUpFutures is an array of {ts: MongoTimestamp, future: Future}
  // objects, sorted by ascending timestamp. _lastProcessedTS is the
  // MongoTimestamp of the last oplog entry we've processed.
  //
  // Each time we call waitUntilCaughtUp, we take a peek at the final oplog
  // entry in the db.  If we've already processed it (ie, it is not greater than
  // _lastProcessedTS), waitUntilCaughtUp immediately returns. Otherwise,
  // waitUntilCaughtUp makes a new Future and inserts it along with the final
  // timestamp entry that it read, into _catchingUpFutures. waitUntilCaughtUp
  // then waits on that future, which is resolved once _lastProcessedTS is
  // incremented to be past its timestamp by the worker fiber.
  //
  // XXX use a priority queue or something else that's faster than an array

  self._catchingUpFutures = [];
  self._lastProcessedTS = null;
  self._onSkippedEntriesHook = new Hook({
    debugPrintExceptions: "onSkippedEntries callback"
  });
  self._entryQueue = new Meteor._DoubleEndedQueue();
  self._workerActive = false;

  self._startTailing();
};

_.extend(OplogHandle.prototype, {
  stop: function () {
    var self = this;
    if (self._stopped) return;
    self._stopped = true;
    if (self._tailHandle) self._tailHandle.stop(); // XXX should close connections too
  },
  onOplogEntry: function (trigger, callback) {
    var self = this;
    if (self._stopped) throw new Error("Called onOplogEntry on stopped handle!"); // Calling onOplogEntry requires us to wait for the tailing to be ready.

    self._readyFuture.wait();

    var originalCallback = callback;
    callback = Meteor.bindEnvironment(function (notification) {
      originalCallback(notification);
    }, function (err) {
      Meteor._debug("Error in oplog callback", err);
    });

    var listenHandle = self._crossbar.listen(trigger, callback);

    return {
      stop: function () {
        listenHandle.stop();
      }
    };
  },
  // Register a callback to be invoked any time we skip oplog entries (eg,
  // because we are too far behind).
  onSkippedEntries: function (callback) {
    var self = this;
    if (self._stopped) throw new Error("Called onSkippedEntries on stopped handle!");
    return self._onSkippedEntriesHook.register(callback);
  },
  // Calls `callback` once the oplog has been processed up to a point that is
  // roughly "now": specifically, once we've processed all ops that are
  // currently visible.
  // XXX become convinced that this is actually safe even if oplogConnection
  // is some kind of pool
  waitUntilCaughtUp: function () {
    var self = this;
    if (self._stopped) throw new Error("Called waitUntilCaughtUp on stopped handle!"); // Calling waitUntilCaughtUp requries us to wait for the oplog connection to
    // be ready.

    self._readyFuture.wait();

    var lastEntry;

    while (!self._stopped) {
      // We need to make the selector at least as restrictive as the actual
      // tailing selector (ie, we need to specify the DB name) or else we might
      // find a TS that won't show up in the actual tail stream.
      try {
        lastEntry = self._oplogLastEntryConnection.findOne(OPLOG_COLLECTION, self._baseOplogSelector, {
          fields: {
            ts: 1
          },
          sort: {
            $natural: -1
          }
        });
        break;
      } catch (e) {
        // During failover (eg) if we get an exception we should log and retry
        // instead of crashing.
        Meteor._debug("Got exception while reading last entry", e);

        Meteor._sleepForMs(100);
      }
    }

    if (self._stopped) return;

    if (!lastEntry) {
      // Really, nothing in the oplog? Well, we've processed everything.
      return;
    }

    var ts = lastEntry.ts;
    if (!ts) throw Error("oplog entry without ts: " + EJSON.stringify(lastEntry));

    if (self._lastProcessedTS && ts.lessThanOrEqual(self._lastProcessedTS)) {
      // We've already caught up to here.
      return;
    } // Insert the future into our list. Almost always, this will be at the end,
    // but it's conceivable that if we fail over from one primary to another,
    // the oplog entries we see will go backwards.


    var insertAfter = self._catchingUpFutures.length;

    while (insertAfter - 1 > 0 && self._catchingUpFutures[insertAfter - 1].ts.greaterThan(ts)) {
      insertAfter--;
    }

    var f = new Future();

    self._catchingUpFutures.splice(insertAfter, 0, {
      ts: ts,
      future: f
    });

    f.wait();
  },
  _startTailing: function () {
    var self = this; // First, make sure that we're talking to the local database.

    var mongodbUri = Npm.require('mongodb-uri');

    if (mongodbUri.parse(self._oplogUrl).database !== 'local') {
      throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of " + "a Mongo replica set");
    } // We make two separate connections to Mongo. The Node Mongo driver
    // implements a naive round-robin connection pool: each "connection" is a
    // pool of several (5 by default) TCP connections, and each request is
    // rotated through the pools. Tailable cursor queries block on the server
    // until there is some data to return (or until a few seconds have
    // passed). So if the connection pool used for tailing cursors is the same
    // pool used for other queries, the other queries will be delayed by seconds
    // 1/5 of the time.
    //
    // The tail connection will only ever be running a single tail command, so
    // it only needs to make one underlying TCP connection.


    self._oplogTailConnection = new MongoConnection(self._oplogUrl, {
      poolSize: 1
    }); // XXX better docs, but: it's to get monotonic results
    // XXX is it safe to say "if there's an in flight query, just use its
    //     results"? I don't think so but should consider that

    self._oplogLastEntryConnection = new MongoConnection(self._oplogUrl, {
      poolSize: 1
    }); // Now, make sure that there actually is a repl set here. If not, oplog
    // tailing won't ever find anything!
    // More on the isMasterDoc
    // https://docs.mongodb.com/manual/reference/command/isMaster/

    var f = new Future();

    self._oplogLastEntryConnection.db.admin().command({
      ismaster: 1
    }, f.resolver());

    var isMasterDoc = f.wait();

    if (!(isMasterDoc && isMasterDoc.setName)) {
      throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of " + "a Mongo replica set");
    } // Find the last oplog entry.


    var lastOplogEntry = self._oplogLastEntryConnection.findOne(OPLOG_COLLECTION, {}, {
      sort: {
        $natural: -1
      },
      fields: {
        ts: 1
      }
    });

    var oplogSelector = _.clone(self._baseOplogSelector);

    if (lastOplogEntry) {
      // Start after the last entry that currently exists.
      oplogSelector.ts = {
        $gt: lastOplogEntry.ts
      }; // If there are any calls to callWhenProcessedLatest before any other
      // oplog entries show up, allow callWhenProcessedLatest to call its
      // callback immediately.

      self._lastProcessedTS = lastOplogEntry.ts;
    }

    var cursorDescription = new CursorDescription(OPLOG_COLLECTION, oplogSelector, {
      tailable: true
    }); // Start tailing the oplog.
    //
    // We restart the low-level oplog query every 30 seconds if we didn't get a
    // doc. This is a workaround for #8598: the Node Mongo driver has at least
    // one bug that can lead to query callbacks never getting called (even with
    // an error) when leadership failover occur.

    self._tailHandle = self._oplogTailConnection.tail(cursorDescription, function (doc) {
      self._entryQueue.push(doc);

      self._maybeStartWorker();
    }, TAIL_TIMEOUT);

    self._readyFuture.return();
  },
  _maybeStartWorker: function () {
    var self = this;
    if (self._workerActive) return;
    self._workerActive = true;
    Meteor.defer(function () {
      // May be called recursively in case of transactions.
      function handleDoc(doc) {
        if (doc.ns === "admin.$cmd") {
          if (doc.o.applyOps) {
            // This was a successful transaction, so we need to apply the
            // operations that were involved.
            let nextTimestamp = doc.ts;
            doc.o.applyOps.forEach(op => {
              // See https://github.com/meteor/meteor/issues/10420.
              if (!op.ts) {
                op.ts = nextTimestamp;
                nextTimestamp = nextTimestamp.add(Timestamp.ONE);
              }

              handleDoc(op);
            });
            return;
          }

          throw new Error("Unknown command " + EJSON.stringify(doc));
        }

        const trigger = {
          dropCollection: false,
          dropDatabase: false,
          op: doc
        };

        if (typeof doc.ns === "string" && doc.ns.startsWith(self._dbName + ".")) {
          trigger.collection = doc.ns.slice(self._dbName.length + 1);
        } // Is it a special command and the collection name is hidden
        // somewhere in operator?


        if (trigger.collection === "$cmd") {
          if (doc.o.dropDatabase) {
            delete trigger.collection;
            trigger.dropDatabase = true;
          } else if (_.has(doc.o, "drop")) {
            trigger.collection = doc.o.drop;
            trigger.dropCollection = true;
            trigger.id = null;
          } else {
            throw Error("Unknown command " + EJSON.stringify(doc));
          }
        } else {
          // All other ops have an id.
          trigger.id = idForOp(doc);
        }

        self._crossbar.fire(trigger);
      }

      try {
        while (!self._stopped && !self._entryQueue.isEmpty()) {
          // Are we too far behind? Just tell our observers that they need to
          // repoll, and drop our queue.
          if (self._entryQueue.length > TOO_FAR_BEHIND) {
            var lastEntry = self._entryQueue.pop();

            self._entryQueue.clear();

            self._onSkippedEntriesHook.each(function (callback) {
              callback();
              return true;
            }); // Free any waitUntilCaughtUp() calls that were waiting for us to
            // pass something that we just skipped.


            self._setLastProcessedTS(lastEntry.ts);

            continue;
          }

          const doc = self._entryQueue.shift(); // Fire trigger(s) for this doc.


          handleDoc(doc); // Now that we've processed this operation, process pending
          // sequencers.

          if (doc.ts) {
            self._setLastProcessedTS(doc.ts);
          } else {
            throw Error("oplog entry without ts: " + EJSON.stringify(doc));
          }
        }
      } finally {
        self._workerActive = false;
      }
    });
  },
  _setLastProcessedTS: function (ts) {
    var self = this;
    self._lastProcessedTS = ts;

    while (!_.isEmpty(self._catchingUpFutures) && self._catchingUpFutures[0].ts.lessThanOrEqual(self._lastProcessedTS)) {
      var sequencer = self._catchingUpFutures.shift();

      sequencer.future.return();
    }
  },
  //Methods used on tests to dinamically change TOO_FAR_BEHIND
  _defineTooFarBehind: function (value) {
    TOO_FAR_BEHIND = value;
  },
  _resetTooFarBehind: function () {
    TOO_FAR_BEHIND = process.env.METEOR_OPLOG_TOO_FAR_BEHIND || 2000;
  }
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"observe_multiplex.js":function module(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/observe_multiplex.js                                                                                 //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var Future = Npm.require('fibers/future');

ObserveMultiplexer = function (options) {
  var self = this;
  if (!options || !_.has(options, 'ordered')) throw Error("must specified ordered");
  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-multiplexers", 1);
  self._ordered = options.ordered;

  self._onStop = options.onStop || function () {};

  self._queue = new Meteor._SynchronousQueue();
  self._handles = {};
  self._readyFuture = new Future();
  self._cache = new LocalCollection._CachingChangeObserver({
    ordered: options.ordered
  }); // Number of addHandleAndSendInitialAdds tasks scheduled but not yet
  // running. removeHandle uses this to know if it's time to call the onStop
  // callback.

  self._addHandleTasksScheduledButNotPerformed = 0;

  _.each(self.callbackNames(), function (callbackName) {
    self[callbackName] = function ()
    /* ... */
    {
      self._applyCallback(callbackName, _.toArray(arguments));
    };
  });
};

_.extend(ObserveMultiplexer.prototype, {
  addHandleAndSendInitialAdds: function (handle) {
    var self = this; // Check this before calling runTask (even though runTask does the same
    // check) so that we don't leak an ObserveMultiplexer on error by
    // incrementing _addHandleTasksScheduledButNotPerformed and never
    // decrementing it.

    if (!self._queue.safeToRunTask()) throw new Error("Can't call observeChanges from an observe callback on the same query");
    ++self._addHandleTasksScheduledButNotPerformed;
    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-handles", 1);

    self._queue.runTask(function () {
      self._handles[handle._id] = handle; // Send out whatever adds we have so far (whether or not we the
      // multiplexer is ready).

      self._sendAdds(handle);

      --self._addHandleTasksScheduledButNotPerformed;
    }); // *outside* the task, since otherwise we'd deadlock


    self._readyFuture.wait();
  },
  // Remove an observe handle. If it was the last observe handle, call the
  // onStop callback; you cannot add any more observe handles after this.
  //
  // This is not synchronized with polls and handle additions: this means that
  // you can safely call it from within an observe callback, but it also means
  // that we have to be careful when we iterate over _handles.
  removeHandle: function (id) {
    var self = this; // This should not be possible: you can only call removeHandle by having
    // access to the ObserveHandle, which isn't returned to user code until the
    // multiplex is ready.

    if (!self._ready()) throw new Error("Can't remove handles until the multiplex is ready");
    delete self._handles[id];
    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-handles", -1);

    if (_.isEmpty(self._handles) && self._addHandleTasksScheduledButNotPerformed === 0) {
      self._stop();
    }
  },
  _stop: function (options) {
    var self = this;
    options = options || {}; // It shouldn't be possible for us to stop when all our handles still
    // haven't been returned from observeChanges!

    if (!self._ready() && !options.fromQueryError) throw Error("surprising _stop: not ready"); // Call stop callback (which kills the underlying process which sends us
    // callbacks and removes us from the connection's dictionary).

    self._onStop();

    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-multiplexers", -1); // Cause future addHandleAndSendInitialAdds calls to throw (but the onStop
    // callback should make our connection forget about us).

    self._handles = null;
  },
  // Allows all addHandleAndSendInitialAdds calls to return, once all preceding
  // adds have been processed. Does not block.
  ready: function () {
    var self = this;

    self._queue.queueTask(function () {
      if (self._ready()) throw Error("can't make ObserveMultiplex ready twice!");

      self._readyFuture.return();
    });
  },
  // If trying to execute the query results in an error, call this. This is
  // intended for permanent errors, not transient network errors that could be
  // fixed. It should only be called before ready(), because if you called ready
  // that meant that you managed to run the query once. It will stop this
  // ObserveMultiplex and cause addHandleAndSendInitialAdds calls (and thus
  // observeChanges calls) to throw the error.
  queryError: function (err) {
    var self = this;

    self._queue.runTask(function () {
      if (self._ready()) throw Error("can't claim query has an error after it worked!");

      self._stop({
        fromQueryError: true
      });

      self._readyFuture.throw(err);
    });
  },
  // Calls "cb" once the effects of all "ready", "addHandleAndSendInitialAdds"
  // and observe callbacks which came before this call have been propagated to
  // all handles. "ready" must have already been called on this multiplexer.
  onFlush: function (cb) {
    var self = this;

    self._queue.queueTask(function () {
      if (!self._ready()) throw Error("only call onFlush on a multiplexer that will be ready");
      cb();
    });
  },
  callbackNames: function () {
    var self = this;
    if (self._ordered) return ["addedBefore", "changed", "movedBefore", "removed"];else return ["added", "changed", "removed"];
  },
  _ready: function () {
    return this._readyFuture.isResolved();
  },
  _applyCallback: function (callbackName, args) {
    var self = this;

    self._queue.queueTask(function () {
      // If we stopped in the meantime, do nothing.
      if (!self._handles) return; // First, apply the change to the cache.
      // XXX We could make applyChange callbacks promise not to hang on to any
      // state from their arguments (assuming that their supplied callbacks
      // don't) and skip this clone. Currently 'changed' hangs on to state
      // though.

      self._cache.applyChange[callbackName].apply(null, EJSON.clone(args)); // If we haven't finished the initial adds, then we should only be getting
      // adds.


      if (!self._ready() && callbackName !== 'added' && callbackName !== 'addedBefore') {
        throw new Error("Got " + callbackName + " during initial adds");
      } // Now multiplex the callbacks out to all observe handles. It's OK if
      // these calls yield; since we're inside a task, no other use of our queue
      // can continue until these are done. (But we do have to be careful to not
      // use a handle that got removed, because removeHandle does not use the
      // queue; thus, we iterate over an array of keys that we control.)


      _.each(_.keys(self._handles), function (handleId) {
        var handle = self._handles && self._handles[handleId];
        if (!handle) return;
        var callback = handle['_' + callbackName]; // clone arguments so that callbacks can mutate their arguments

        callback && callback.apply(null, EJSON.clone(args));
      });
    });
  },
  // Sends initial adds to a handle. It should only be called from within a task
  // (the task that is processing the addHandleAndSendInitialAdds call). It
  // synchronously invokes the handle's added or addedBefore; there's no need to
  // flush the queue afterwards to ensure that the callbacks get out.
  _sendAdds: function (handle) {
    var self = this;
    if (self._queue.safeToRunTask()) throw Error("_sendAdds may only be called from within a task!");
    var add = self._ordered ? handle._addedBefore : handle._added;
    if (!add) return; // note: docs may be an _IdMap or an OrderedDict

    self._cache.docs.forEach(function (doc, id) {
      if (!_.has(self._handles, handle._id)) throw Error("handle got removed before sending initial adds!");
      var fields = EJSON.clone(doc);
      delete fields._id;
      if (self._ordered) add(id, fields, null); // we're going in order, so add at end
      else add(id, fields);
    });
  }
});

var nextObserveHandleId = 1;

ObserveHandle = function (multiplexer, callbacks) {
  var self = this; // The end user is only supposed to call stop().  The other fields are
  // accessible to the multiplexer, though.

  self._multiplexer = multiplexer;

  _.each(multiplexer.callbackNames(), function (name) {
    if (callbacks[name]) {
      self['_' + name] = callbacks[name];
    } else if (name === "addedBefore" && callbacks.added) {
      // Special case: if you specify "added" and "movedBefore", you get an
      // ordered observe where for some reason you don't get ordering data on
      // the adds.  I dunno, we wrote tests for it, there must have been a
      // reason.
      self._addedBefore = function (id, fields, before) {
        callbacks.added(id, fields);
      };
    }
  });

  self._stopped = false;
  self._id = nextObserveHandleId++;
};

ObserveHandle.prototype.stop = function () {
  var self = this;
  if (self._stopped) return;
  self._stopped = true;

  self._multiplexer.removeHandle(self._id);
};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"doc_fetcher.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/doc_fetcher.js                                                                                       //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  DocFetcher: () => DocFetcher
});

var Fiber = Npm.require('fibers');

class DocFetcher {
  constructor(mongoConnection) {
    this._mongoConnection = mongoConnection; // Map from op -> [callback]

    this._callbacksForOp = new Map();
  } // Fetches document "id" from collectionName, returning it or null if not
  // found.
  //
  // If you make multiple calls to fetch() with the same op reference,
  // DocFetcher may assume that they all return the same document. (It does
  // not check to see if collectionName/id match.)
  //
  // You may assume that callback is never called synchronously (and in fact
  // OplogObserveDriver does so).


  fetch(collectionName, id, op, callback) {
    const self = this;
    check(collectionName, String);
    check(op, Object); // If there's already an in-progress fetch for this cache key, yield until
    // it's done and return whatever it returns.

    if (self._callbacksForOp.has(op)) {
      self._callbacksForOp.get(op).push(callback);

      return;
    }

    const callbacks = [callback];

    self._callbacksForOp.set(op, callbacks);

    Fiber(function () {
      try {
        var doc = self._mongoConnection.findOne(collectionName, {
          _id: id
        }) || null; // Return doc to all relevant callbacks. Note that this array can
        // continue to grow during callback excecution.

        while (callbacks.length > 0) {
          // Clone the document so that the various calls to fetch don't return
          // objects that are intertwingled with each other. Clone before
          // popping the future, so that if clone throws, the error gets passed
          // to the next callback.
          callbacks.pop()(null, EJSON.clone(doc));
        }
      } catch (e) {
        while (callbacks.length > 0) {
          callbacks.pop()(e);
        }
      } finally {
        // XXX consider keeping the doc around for a period of time before
        // removing from the cache
        self._callbacksForOp.delete(op);
      }
    }).run();
  }

}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"polling_observe_driver.js":function module(){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/polling_observe_driver.js                                                                            //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var POLLING_THROTTLE_MS = +process.env.METEOR_POLLING_THROTTLE_MS || 50;
var POLLING_INTERVAL_MS = +process.env.METEOR_POLLING_INTERVAL_MS || 10 * 1000;

PollingObserveDriver = function (options) {
  var self = this;
  self._cursorDescription = options.cursorDescription;
  self._mongoHandle = options.mongoHandle;
  self._ordered = options.ordered;
  self._multiplexer = options.multiplexer;
  self._stopCallbacks = [];
  self._stopped = false;
  self._synchronousCursor = self._mongoHandle._createSynchronousCursor(self._cursorDescription); // previous results snapshot.  on each poll cycle, diffs against
  // results drives the callbacks.

  self._results = null; // The number of _pollMongo calls that have been added to self._taskQueue but
  // have not started running. Used to make sure we never schedule more than one
  // _pollMongo (other than possibly the one that is currently running). It's
  // also used by _suspendPolling to pretend there's a poll scheduled. Usually,
  // it's either 0 (for "no polls scheduled other than maybe one currently
  // running") or 1 (for "a poll scheduled that isn't running yet"), but it can
  // also be 2 if incremented by _suspendPolling.

  self._pollsScheduledButNotStarted = 0;
  self._pendingWrites = []; // people to notify when polling completes
  // Make sure to create a separately throttled function for each
  // PollingObserveDriver object.

  self._ensurePollIsScheduled = _.throttle(self._unthrottledEnsurePollIsScheduled, self._cursorDescription.options.pollingThrottleMs || POLLING_THROTTLE_MS
  /* ms */
  ); // XXX figure out if we still need a queue

  self._taskQueue = new Meteor._SynchronousQueue();
  var listenersHandle = listenAll(self._cursorDescription, function (notification) {
    // When someone does a transaction that might affect us, schedule a poll
    // of the database. If that transaction happens inside of a write fence,
    // block the fence until we've polled and notified observers.
    var fence = DDPServer._CurrentWriteFence.get();

    if (fence) self._pendingWrites.push(fence.beginWrite()); // Ensure a poll is scheduled... but if we already know that one is,
    // don't hit the throttled _ensurePollIsScheduled function (which might
    // lead to us calling it unnecessarily in <pollingThrottleMs> ms).

    if (self._pollsScheduledButNotStarted === 0) self._ensurePollIsScheduled();
  });

  self._stopCallbacks.push(function () {
    listenersHandle.stop();
  }); // every once and a while, poll even if we don't think we're dirty, for
  // eventual consistency with database writes from outside the Meteor
  // universe.
  //
  // For testing, there's an undocumented callback argument to observeChanges
  // which disables time-based polling and gets called at the beginning of each
  // poll.


  if (options._testOnlyPollCallback) {
    self._testOnlyPollCallback = options._testOnlyPollCallback;
  } else {
    var pollingInterval = self._cursorDescription.options.pollingIntervalMs || self._cursorDescription.options._pollingInterval || // COMPAT with 1.2
    POLLING_INTERVAL_MS;
    var intervalHandle = Meteor.setInterval(_.bind(self._ensurePollIsScheduled, self), pollingInterval);

    self._stopCallbacks.push(function () {
      Meteor.clearInterval(intervalHandle);
    });
  } // Make sure we actually poll soon!


  self._unthrottledEnsurePollIsScheduled();

  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-drivers-polling", 1);
};

_.extend(PollingObserveDriver.prototype, {
  // This is always called through _.throttle (except once at startup).
  _unthrottledEnsurePollIsScheduled: function () {
    var self = this;
    if (self._pollsScheduledButNotStarted > 0) return;
    ++self._pollsScheduledButNotStarted;

    self._taskQueue.queueTask(function () {
      self._pollMongo();
    });
  },
  // test-only interface for controlling polling.
  //
  // _suspendPolling blocks until any currently running and scheduled polls are
  // done, and prevents any further polls from being scheduled. (new
  // ObserveHandles can be added and receive their initial added callbacks,
  // though.)
  //
  // _resumePolling immediately polls, and allows further polls to occur.
  _suspendPolling: function () {
    var self = this; // Pretend that there's another poll scheduled (which will prevent
    // _ensurePollIsScheduled from queueing any more polls).

    ++self._pollsScheduledButNotStarted; // Now block until all currently running or scheduled polls are done.

    self._taskQueue.runTask(function () {}); // Confirm that there is only one "poll" (the fake one we're pretending to
    // have) scheduled.


    if (self._pollsScheduledButNotStarted !== 1) throw new Error("_pollsScheduledButNotStarted is " + self._pollsScheduledButNotStarted);
  },
  _resumePolling: function () {
    var self = this; // We should be in the same state as in the end of _suspendPolling.

    if (self._pollsScheduledButNotStarted !== 1) throw new Error("_pollsScheduledButNotStarted is " + self._pollsScheduledButNotStarted); // Run a poll synchronously (which will counteract the
    // ++_pollsScheduledButNotStarted from _suspendPolling).

    self._taskQueue.runTask(function () {
      self._pollMongo();
    });
  },
  _pollMongo: function () {
    var self = this;
    --self._pollsScheduledButNotStarted;
    if (self._stopped) return;
    var first = false;
    var newResults;
    var oldResults = self._results;

    if (!oldResults) {
      first = true; // XXX maybe use OrderedDict instead?

      oldResults = self._ordered ? [] : new LocalCollection._IdMap();
    }

    self._testOnlyPollCallback && self._testOnlyPollCallback(); // Save the list of pending writes which this round will commit.

    var writesForCycle = self._pendingWrites;
    self._pendingWrites = []; // Get the new query results. (This yields.)

    try {
      newResults = self._synchronousCursor.getRawObjects(self._ordered);
    } catch (e) {
      if (first && typeof e.code === 'number') {
        // This is an error document sent to us by mongod, not a connection
        // error generated by the client. And we've never seen this query work
        // successfully. Probably it's a bad selector or something, so we should
        // NOT retry. Instead, we should halt the observe (which ends up calling
        // `stop` on us).
        self._multiplexer.queryError(new Error("Exception while polling query " + JSON.stringify(self._cursorDescription) + ": " + e.message));

        return;
      } // getRawObjects can throw if we're having trouble talking to the
      // database.  That's fine --- we will repoll later anyway. But we should
      // make sure not to lose track of this cycle's writes.
      // (It also can throw if there's just something invalid about this query;
      // unfortunately the ObserveDriver API doesn't provide a good way to
      // "cancel" the observe from the inside in this case.


      Array.prototype.push.apply(self._pendingWrites, writesForCycle);

      Meteor._debug("Exception while polling query " + JSON.stringify(self._cursorDescription), e);

      return;
    } // Run diffs.


    if (!self._stopped) {
      LocalCollection._diffQueryChanges(self._ordered, oldResults, newResults, self._multiplexer);
    } // Signals the multiplexer to allow all observeChanges calls that share this
    // multiplexer to return. (This happens asynchronously, via the
    // multiplexer's queue.)


    if (first) self._multiplexer.ready(); // Replace self._results atomically.  (This assignment is what makes `first`
    // stay through on the next cycle, so we've waited until after we've
    // committed to ready-ing the multiplexer.)

    self._results = newResults; // Once the ObserveMultiplexer has processed everything we've done in this
    // round, mark all the writes which existed before this call as
    // commmitted. (If new writes have shown up in the meantime, there'll
    // already be another _pollMongo task scheduled.)

    self._multiplexer.onFlush(function () {
      _.each(writesForCycle, function (w) {
        w.committed();
      });
    });
  },
  stop: function () {
    var self = this;
    self._stopped = true;

    _.each(self._stopCallbacks, function (c) {
      c();
    }); // Release any write fences that are waiting on us.


    _.each(self._pendingWrites, function (w) {
      w.committed();
    });

    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-drivers-polling", -1);
  }
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"oplog_observe_driver.js":function module(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/oplog_observe_driver.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var Future = Npm.require('fibers/future');

var PHASE = {
  QUERYING: "QUERYING",
  FETCHING: "FETCHING",
  STEADY: "STEADY"
}; // Exception thrown by _needToPollQuery which unrolls the stack up to the
// enclosing call to finishIfNeedToPollQuery.

var SwitchedToQuery = function () {};

var finishIfNeedToPollQuery = function (f) {
  return function () {
    try {
      f.apply(this, arguments);
    } catch (e) {
      if (!(e instanceof SwitchedToQuery)) throw e;
    }
  };
};

var currentId = 0; // OplogObserveDriver is an alternative to PollingObserveDriver which follows
// the Mongo operation log instead of just re-polling the query. It obeys the
// same simple interface: constructing it starts sending observeChanges
// callbacks (and a ready() invocation) to the ObserveMultiplexer, and you stop
// it by calling the stop() method.

OplogObserveDriver = function (options) {
  var self = this;
  self._usesOplog = true; // tests look at this

  self._id = currentId;
  currentId++;
  self._cursorDescription = options.cursorDescription;
  self._mongoHandle = options.mongoHandle;
  self._multiplexer = options.multiplexer;

  if (options.ordered) {
    throw Error("OplogObserveDriver only supports unordered observeChanges");
  }

  var sorter = options.sorter; // We don't support $near and other geo-queries so it's OK to initialize the
  // comparator only once in the constructor.

  var comparator = sorter && sorter.getComparator();

  if (options.cursorDescription.options.limit) {
    // There are several properties ordered driver implements:
    // - _limit is a positive number
    // - _comparator is a function-comparator by which the query is ordered
    // - _unpublishedBuffer is non-null Min/Max Heap,
    //                      the empty buffer in STEADY phase implies that the
    //                      everything that matches the queries selector fits
    //                      into published set.
    // - _published - Min Heap (also implements IdMap methods)
    var heapOptions = {
      IdMap: LocalCollection._IdMap
    };
    self._limit = self._cursorDescription.options.limit;
    self._comparator = comparator;
    self._sorter = sorter;
    self._unpublishedBuffer = new MinMaxHeap(comparator, heapOptions); // We need something that can find Max value in addition to IdMap interface

    self._published = new MaxHeap(comparator, heapOptions);
  } else {
    self._limit = 0;
    self._comparator = null;
    self._sorter = null;
    self._unpublishedBuffer = null;
    self._published = new LocalCollection._IdMap();
  } // Indicates if it is safe to insert a new document at the end of the buffer
  // for this query. i.e. it is known that there are no documents matching the
  // selector those are not in published or buffer.


  self._safeAppendToBuffer = false;
  self._stopped = false;
  self._stopHandles = [];
  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-drivers-oplog", 1);

  self._registerPhaseChange(PHASE.QUERYING);

  self._matcher = options.matcher;
  var projection = self._cursorDescription.options.fields || {};
  self._projectionFn = LocalCollection._compileProjection(projection); // Projection function, result of combining important fields for selector and
  // existing fields projection

  self._sharedProjection = self._matcher.combineIntoProjection(projection);
  if (sorter) self._sharedProjection = sorter.combineIntoProjection(self._sharedProjection);
  self._sharedProjectionFn = LocalCollection._compileProjection(self._sharedProjection);
  self._needToFetch = new LocalCollection._IdMap();
  self._currentlyFetching = null;
  self._fetchGeneration = 0;
  self._requeryWhenDoneThisQuery = false;
  self._writesToCommitWhenWeReachSteady = []; // If the oplog handle tells us that it skipped some entries (because it got
  // behind, say), re-poll.

  self._stopHandles.push(self._mongoHandle._oplogHandle.onSkippedEntries(finishIfNeedToPollQuery(function () {
    self._needToPollQuery();
  })));

  forEachTrigger(self._cursorDescription, function (trigger) {
    self._stopHandles.push(self._mongoHandle._oplogHandle.onOplogEntry(trigger, function (notification) {
      Meteor._noYieldsAllowed(finishIfNeedToPollQuery(function () {
        var op = notification.op;

        if (notification.dropCollection || notification.dropDatabase) {
          // Note: this call is not allowed to block on anything (especially
          // on waiting for oplog entries to catch up) because that will block
          // onOplogEntry!
          self._needToPollQuery();
        } else {
          // All other operators should be handled depending on phase
          if (self._phase === PHASE.QUERYING) {
            self._handleOplogEntryQuerying(op);
          } else {
            self._handleOplogEntrySteadyOrFetching(op);
          }
        }
      }));
    }));
  }); // XXX ordering w.r.t. everything else?

  self._stopHandles.push(listenAll(self._cursorDescription, function (notification) {
    // If we're not in a pre-fire write fence, we don't have to do anything.
    var fence = DDPServer._CurrentWriteFence.get();

    if (!fence || fence.fired) return;

    if (fence._oplogObserveDrivers) {
      fence._oplogObserveDrivers[self._id] = self;
      return;
    }

    fence._oplogObserveDrivers = {};
    fence._oplogObserveDrivers[self._id] = self;
    fence.onBeforeFire(function () {
      var drivers = fence._oplogObserveDrivers;
      delete fence._oplogObserveDrivers; // This fence cannot fire until we've caught up to "this point" in the
      // oplog, and all observers made it back to the steady state.

      self._mongoHandle._oplogHandle.waitUntilCaughtUp();

      _.each(drivers, function (driver) {
        if (driver._stopped) return;
        var write = fence.beginWrite();

        if (driver._phase === PHASE.STEADY) {
          // Make sure that all of the callbacks have made it through the
          // multiplexer and been delivered to ObserveHandles before committing
          // writes.
          driver._multiplexer.onFlush(function () {
            write.committed();
          });
        } else {
          driver._writesToCommitWhenWeReachSteady.push(write);
        }
      });
    });
  })); // When Mongo fails over, we need to repoll the query, in case we processed an
  // oplog entry that got rolled back.


  self._stopHandles.push(self._mongoHandle._onFailover(finishIfNeedToPollQuery(function () {
    self._needToPollQuery();
  }))); // Give _observeChanges a chance to add the new ObserveHandle to our
  // multiplexer, so that the added calls get streamed.


  Meteor.defer(finishIfNeedToPollQuery(function () {
    self._runInitialQuery();
  }));
};

_.extend(OplogObserveDriver.prototype, {
  _addPublished: function (id, doc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var fields = _.clone(doc);

      delete fields._id;

      self._published.set(id, self._sharedProjectionFn(doc));

      self._multiplexer.added(id, self._projectionFn(fields)); // After adding this document, the published set might be overflowed
      // (exceeding capacity specified by limit). If so, push the maximum
      // element to the buffer, we might want to save it in memory to reduce the
      // amount of Mongo lookups in the future.


      if (self._limit && self._published.size() > self._limit) {
        // XXX in theory the size of published is no more than limit+1
        if (self._published.size() !== self._limit + 1) {
          throw new Error("After adding to published, " + (self._published.size() - self._limit) + " documents are overflowing the set");
        }

        var overflowingDocId = self._published.maxElementId();

        var overflowingDoc = self._published.get(overflowingDocId);

        if (EJSON.equals(overflowingDocId, id)) {
          throw new Error("The document just added is overflowing the published set");
        }

        self._published.remove(overflowingDocId);

        self._multiplexer.removed(overflowingDocId);

        self._addBuffered(overflowingDocId, overflowingDoc);
      }
    });
  },
  _removePublished: function (id) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._published.remove(id);

      self._multiplexer.removed(id);

      if (!self._limit || self._published.size() === self._limit) return;
      if (self._published.size() > self._limit) throw Error("self._published got too big"); // OK, we are publishing less than the limit. Maybe we should look in the
      // buffer to find the next element past what we were publishing before.

      if (!self._unpublishedBuffer.empty()) {
        // There's something in the buffer; move the first thing in it to
        // _published.
        var newDocId = self._unpublishedBuffer.minElementId();

        var newDoc = self._unpublishedBuffer.get(newDocId);

        self._removeBuffered(newDocId);

        self._addPublished(newDocId, newDoc);

        return;
      } // There's nothing in the buffer.  This could mean one of a few things.
      // (a) We could be in the middle of re-running the query (specifically, we
      // could be in _publishNewResults). In that case, _unpublishedBuffer is
      // empty because we clear it at the beginning of _publishNewResults. In
      // this case, our caller already knows the entire answer to the query and
      // we don't need to do anything fancy here.  Just return.


      if (self._phase === PHASE.QUERYING) return; // (b) We're pretty confident that the union of _published and
      // _unpublishedBuffer contain all documents that match selector. Because
      // _unpublishedBuffer is empty, that means we're confident that _published
      // contains all documents that match selector. So we have nothing to do.

      if (self._safeAppendToBuffer) return; // (c) Maybe there are other documents out there that should be in our
      // buffer. But in that case, when we emptied _unpublishedBuffer in
      // _removeBuffered, we should have called _needToPollQuery, which will
      // either put something in _unpublishedBuffer or set _safeAppendToBuffer
      // (or both), and it will put us in QUERYING for that whole time. So in
      // fact, we shouldn't be able to get here.

      throw new Error("Buffer inexplicably empty");
    });
  },
  _changePublished: function (id, oldDoc, newDoc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._published.set(id, self._sharedProjectionFn(newDoc));

      var projectedNew = self._projectionFn(newDoc);

      var projectedOld = self._projectionFn(oldDoc);

      var changed = DiffSequence.makeChangedFields(projectedNew, projectedOld);
      if (!_.isEmpty(changed)) self._multiplexer.changed(id, changed);
    });
  },
  _addBuffered: function (id, doc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._unpublishedBuffer.set(id, self._sharedProjectionFn(doc)); // If something is overflowing the buffer, we just remove it from cache


      if (self._unpublishedBuffer.size() > self._limit) {
        var maxBufferedId = self._unpublishedBuffer.maxElementId();

        self._unpublishedBuffer.remove(maxBufferedId); // Since something matching is removed from cache (both published set and
        // buffer), set flag to false


        self._safeAppendToBuffer = false;
      }
    });
  },
  // Is called either to remove the doc completely from matching set or to move
  // it to the published set later.
  _removeBuffered: function (id) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._unpublishedBuffer.remove(id); // To keep the contract "buffer is never empty in STEADY phase unless the
      // everything matching fits into published" true, we poll everything as
      // soon as we see the buffer becoming empty.


      if (!self._unpublishedBuffer.size() && !self._safeAppendToBuffer) self._needToPollQuery();
    });
  },
  // Called when a document has joined the "Matching" results set.
  // Takes responsibility of keeping _unpublishedBuffer in sync with _published
  // and the effect of limit enforced.
  _addMatching: function (doc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var id = doc._id;
      if (self._published.has(id)) throw Error("tried to add something already published " + id);
      if (self._limit && self._unpublishedBuffer.has(id)) throw Error("tried to add something already existed in buffer " + id);
      var limit = self._limit;
      var comparator = self._comparator;
      var maxPublished = limit && self._published.size() > 0 ? self._published.get(self._published.maxElementId()) : null;
      var maxBuffered = limit && self._unpublishedBuffer.size() > 0 ? self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId()) : null; // The query is unlimited or didn't publish enough documents yet or the
      // new document would fit into published set pushing the maximum element
      // out, then we need to publish the doc.

      var toPublish = !limit || self._published.size() < limit || comparator(doc, maxPublished) < 0; // Otherwise we might need to buffer it (only in case of limited query).
      // Buffering is allowed if the buffer is not filled up yet and all
      // matching docs are either in the published set or in the buffer.

      var canAppendToBuffer = !toPublish && self._safeAppendToBuffer && self._unpublishedBuffer.size() < limit; // Or if it is small enough to be safely inserted to the middle or the
      // beginning of the buffer.

      var canInsertIntoBuffer = !toPublish && maxBuffered && comparator(doc, maxBuffered) <= 0;
      var toBuffer = canAppendToBuffer || canInsertIntoBuffer;

      if (toPublish) {
        self._addPublished(id, doc);
      } else if (toBuffer) {
        self._addBuffered(id, doc);
      } else {
        // dropping it and not saving to the cache
        self._safeAppendToBuffer = false;
      }
    });
  },
  // Called when a document leaves the "Matching" results set.
  // Takes responsibility of keeping _unpublishedBuffer in sync with _published
  // and the effect of limit enforced.
  _removeMatching: function (id) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      if (!self._published.has(id) && !self._limit) throw Error("tried to remove something matching but not cached " + id);

      if (self._published.has(id)) {
        self._removePublished(id);
      } else if (self._unpublishedBuffer.has(id)) {
        self._removeBuffered(id);
      }
    });
  },
  _handleDoc: function (id, newDoc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var matchesNow = newDoc && self._matcher.documentMatches(newDoc).result;

      var publishedBefore = self._published.has(id);

      var bufferedBefore = self._limit && self._unpublishedBuffer.has(id);

      var cachedBefore = publishedBefore || bufferedBefore;

      if (matchesNow && !cachedBefore) {
        self._addMatching(newDoc);
      } else if (cachedBefore && !matchesNow) {
        self._removeMatching(id);
      } else if (cachedBefore && matchesNow) {
        var oldDoc = self._published.get(id);

        var comparator = self._comparator;

        var minBuffered = self._limit && self._unpublishedBuffer.size() && self._unpublishedBuffer.get(self._unpublishedBuffer.minElementId());

        var maxBuffered;

        if (publishedBefore) {
          // Unlimited case where the document stays in published once it
          // matches or the case when we don't have enough matching docs to
          // publish or the changed but matching doc will stay in published
          // anyways.
          //
          // XXX: We rely on the emptiness of buffer. Be sure to maintain the
          // fact that buffer can't be empty if there are matching documents not
          // published. Notably, we don't want to schedule repoll and continue
          // relying on this property.
          var staysInPublished = !self._limit || self._unpublishedBuffer.size() === 0 || comparator(newDoc, minBuffered) <= 0;

          if (staysInPublished) {
            self._changePublished(id, oldDoc, newDoc);
          } else {
            // after the change doc doesn't stay in the published, remove it
            self._removePublished(id); // but it can move into buffered now, check it


            maxBuffered = self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId());
            var toBuffer = self._safeAppendToBuffer || maxBuffered && comparator(newDoc, maxBuffered) <= 0;

            if (toBuffer) {
              self._addBuffered(id, newDoc);
            } else {
              // Throw away from both published set and buffer
              self._safeAppendToBuffer = false;
            }
          }
        } else if (bufferedBefore) {
          oldDoc = self._unpublishedBuffer.get(id); // remove the old version manually instead of using _removeBuffered so
          // we don't trigger the querying immediately.  if we end this block
          // with the buffer empty, we will need to trigger the query poll
          // manually too.

          self._unpublishedBuffer.remove(id);

          var maxPublished = self._published.get(self._published.maxElementId());

          maxBuffered = self._unpublishedBuffer.size() && self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId()); // the buffered doc was updated, it could move to published

          var toPublish = comparator(newDoc, maxPublished) < 0; // or stays in buffer even after the change

          var staysInBuffer = !toPublish && self._safeAppendToBuffer || !toPublish && maxBuffered && comparator(newDoc, maxBuffered) <= 0;

          if (toPublish) {
            self._addPublished(id, newDoc);
          } else if (staysInBuffer) {
            // stays in buffer but changes
            self._unpublishedBuffer.set(id, newDoc);
          } else {
            // Throw away from both published set and buffer
            self._safeAppendToBuffer = false; // Normally this check would have been done in _removeBuffered but
            // we didn't use it, so we need to do it ourself now.

            if (!self._unpublishedBuffer.size()) {
              self._needToPollQuery();
            }
          }
        } else {
          throw new Error("cachedBefore implies either of publishedBefore or bufferedBefore is true.");
        }
      }
    });
  },
  _fetchModifiedDocuments: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._registerPhaseChange(PHASE.FETCHING); // Defer, because nothing called from the oplog entry handler may yield,
      // but fetch() yields.


      Meteor.defer(finishIfNeedToPollQuery(function () {
        while (!self._stopped && !self._needToFetch.empty()) {
          if (self._phase === PHASE.QUERYING) {
            // While fetching, we decided to go into QUERYING mode, and then we
            // saw another oplog entry, so _needToFetch is not empty. But we
            // shouldn't fetch these documents until AFTER the query is done.
            break;
          } // Being in steady phase here would be surprising.


          if (self._phase !== PHASE.FETCHING) throw new Error("phase in fetchModifiedDocuments: " + self._phase);
          self._currentlyFetching = self._needToFetch;
          var thisGeneration = ++self._fetchGeneration;
          self._needToFetch = new LocalCollection._IdMap();
          var waiting = 0;
          var fut = new Future(); // This loop is safe, because _currentlyFetching will not be updated
          // during this loop (in fact, it is never mutated).

          self._currentlyFetching.forEach(function (op, id) {
            waiting++;

            self._mongoHandle._docFetcher.fetch(self._cursorDescription.collectionName, id, op, finishIfNeedToPollQuery(function (err, doc) {
              try {
                if (err) {
                  Meteor._debug("Got exception while fetching documents", err); // If we get an error from the fetcher (eg, trouble
                  // connecting to Mongo), let's just abandon the fetch phase
                  // altogether and fall back to polling. It's not like we're
                  // getting live updates anyway.


                  if (self._phase !== PHASE.QUERYING) {
                    self._needToPollQuery();
                  }
                } else if (!self._stopped && self._phase === PHASE.FETCHING && self._fetchGeneration === thisGeneration) {
                  // We re-check the generation in case we've had an explicit
                  // _pollQuery call (eg, in another fiber) which should
                  // effectively cancel this round of fetches.  (_pollQuery
                  // increments the generation.)
                  self._handleDoc(id, doc);
                }
              } finally {
                waiting--; // Because fetch() never calls its callback synchronously,
                // this is safe (ie, we won't call fut.return() before the
                // forEach is done).

                if (waiting === 0) fut.return();
              }
            }));
          });

          fut.wait(); // Exit now if we've had a _pollQuery call (here or in another fiber).

          if (self._phase === PHASE.QUERYING) return;
          self._currentlyFetching = null;
        } // We're done fetching, so we can be steady, unless we've had a
        // _pollQuery call (here or in another fiber).


        if (self._phase !== PHASE.QUERYING) self._beSteady();
      }));
    });
  },
  _beSteady: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._registerPhaseChange(PHASE.STEADY);

      var writes = self._writesToCommitWhenWeReachSteady;
      self._writesToCommitWhenWeReachSteady = [];

      self._multiplexer.onFlush(function () {
        _.each(writes, function (w) {
          w.committed();
        });
      });
    });
  },
  _handleOplogEntryQuerying: function (op) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._needToFetch.set(idForOp(op), op);
    });
  },
  _handleOplogEntrySteadyOrFetching: function (op) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var id = idForOp(op); // If we're already fetching this one, or about to, we can't optimize;
      // make sure that we fetch it again if necessary.

      if (self._phase === PHASE.FETCHING && (self._currentlyFetching && self._currentlyFetching.has(id) || self._needToFetch.has(id))) {
        self._needToFetch.set(id, op);

        return;
      }

      if (op.op === 'd') {
        if (self._published.has(id) || self._limit && self._unpublishedBuffer.has(id)) self._removeMatching(id);
      } else if (op.op === 'i') {
        if (self._published.has(id)) throw new Error("insert found for already-existing ID in published");
        if (self._unpublishedBuffer && self._unpublishedBuffer.has(id)) throw new Error("insert found for already-existing ID in buffer"); // XXX what if selector yields?  for now it can't but later it could
        // have $where

        if (self._matcher.documentMatches(op.o).result) self._addMatching(op.o);
      } else if (op.op === 'u') {
        // Is this a modifier ($set/$unset, which may require us to poll the
        // database to figure out if the whole document matches the selector) or
        // a replacement (in which case we can just directly re-evaluate the
        // selector)?
        var isReplace = !_.has(op.o, '$set') && !_.has(op.o, '$unset'); // If this modifier modifies something inside an EJSON custom type (ie,
        // anything with EJSON$), then we can't try to use
        // LocalCollection._modify, since that just mutates the EJSON encoding,
        // not the actual object.

        var canDirectlyModifyDoc = !isReplace && modifierCanBeDirectlyApplied(op.o);

        var publishedBefore = self._published.has(id);

        var bufferedBefore = self._limit && self._unpublishedBuffer.has(id);

        if (isReplace) {
          self._handleDoc(id, _.extend({
            _id: id
          }, op.o));
        } else if ((publishedBefore || bufferedBefore) && canDirectlyModifyDoc) {
          // Oh great, we actually know what the document is, so we can apply
          // this directly.
          var newDoc = self._published.has(id) ? self._published.get(id) : self._unpublishedBuffer.get(id);
          newDoc = EJSON.clone(newDoc);
          newDoc._id = id;

          try {
            LocalCollection._modify(newDoc, op.o);
          } catch (e) {
            if (e.name !== "MinimongoError") throw e; // We didn't understand the modifier.  Re-fetch.

            self._needToFetch.set(id, op);

            if (self._phase === PHASE.STEADY) {
              self._fetchModifiedDocuments();
            }

            return;
          }

          self._handleDoc(id, self._sharedProjectionFn(newDoc));
        } else if (!canDirectlyModifyDoc || self._matcher.canBecomeTrueByModifier(op.o) || self._sorter && self._sorter.affectedByModifier(op.o)) {
          self._needToFetch.set(id, op);

          if (self._phase === PHASE.STEADY) self._fetchModifiedDocuments();
        }
      } else {
        throw Error("XXX SURPRISING OPERATION: " + op);
      }
    });
  },
  // Yields!
  _runInitialQuery: function () {
    var self = this;
    if (self._stopped) throw new Error("oplog stopped surprisingly early");

    self._runQuery({
      initial: true
    }); // yields


    if (self._stopped) return; // can happen on queryError
    // Allow observeChanges calls to return. (After this, it's possible for
    // stop() to be called.)

    self._multiplexer.ready();

    self._doneQuerying(); // yields

  },
  // In various circumstances, we may just want to stop processing the oplog and
  // re-run the initial query, just as if we were a PollingObserveDriver.
  //
  // This function may not block, because it is called from an oplog entry
  // handler.
  //
  // XXX We should call this when we detect that we've been in FETCHING for "too
  // long".
  //
  // XXX We should call this when we detect Mongo failover (since that might
  // mean that some of the oplog entries we have processed have been rolled
  // back). The Node Mongo driver is in the middle of a bunch of huge
  // refactorings, including the way that it notifies you when primary
  // changes. Will put off implementing this until driver 1.4 is out.
  _pollQuery: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      if (self._stopped) return; // Yay, we get to forget about all the things we thought we had to fetch.

      self._needToFetch = new LocalCollection._IdMap();
      self._currentlyFetching = null;
      ++self._fetchGeneration; // ignore any in-flight fetches

      self._registerPhaseChange(PHASE.QUERYING); // Defer so that we don't yield.  We don't need finishIfNeedToPollQuery
      // here because SwitchedToQuery is not thrown in QUERYING mode.


      Meteor.defer(function () {
        self._runQuery();

        self._doneQuerying();
      });
    });
  },
  // Yields!
  _runQuery: function (options) {
    var self = this;
    options = options || {};
    var newResults, newBuffer; // This while loop is just to retry failures.

    while (true) {
      // If we've been stopped, we don't have to run anything any more.
      if (self._stopped) return;
      newResults = new LocalCollection._IdMap();
      newBuffer = new LocalCollection._IdMap(); // Query 2x documents as the half excluded from the original query will go
      // into unpublished buffer to reduce additional Mongo lookups in cases
      // when documents are removed from the published set and need a
      // replacement.
      // XXX needs more thought on non-zero skip
      // XXX 2 is a "magic number" meaning there is an extra chunk of docs for
      // buffer if such is needed.

      var cursor = self._cursorForQuery({
        limit: self._limit * 2
      });

      try {
        cursor.forEach(function (doc, i) {
          // yields
          if (!self._limit || i < self._limit) {
            newResults.set(doc._id, doc);
          } else {
            newBuffer.set(doc._id, doc);
          }
        });
        break;
      } catch (e) {
        if (options.initial && typeof e.code === 'number') {
          // This is an error document sent to us by mongod, not a connection
          // error generated by the client. And we've never seen this query work
          // successfully. Probably it's a bad selector or something, so we
          // should NOT retry. Instead, we should halt the observe (which ends
          // up calling `stop` on us).
          self._multiplexer.queryError(e);

          return;
        } // During failover (eg) if we get an exception we should log and retry
        // instead of crashing.


        Meteor._debug("Got exception while polling query", e);

        Meteor._sleepForMs(100);
      }
    }

    if (self._stopped) return;

    self._publishNewResults(newResults, newBuffer);
  },
  // Transitions to QUERYING and runs another query, or (if already in QUERYING)
  // ensures that we will query again later.
  //
  // This function may not block, because it is called from an oplog entry
  // handler. However, if we were not already in the QUERYING phase, it throws
  // an exception that is caught by the closest surrounding
  // finishIfNeedToPollQuery call; this ensures that we don't continue running
  // close that was designed for another phase inside PHASE.QUERYING.
  //
  // (It's also necessary whenever logic in this file yields to check that other
  // phases haven't put us into QUERYING mode, though; eg,
  // _fetchModifiedDocuments does this.)
  _needToPollQuery: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      if (self._stopped) return; // If we're not already in the middle of a query, we can query now
      // (possibly pausing FETCHING).

      if (self._phase !== PHASE.QUERYING) {
        self._pollQuery();

        throw new SwitchedToQuery();
      } // We're currently in QUERYING. Set a flag to ensure that we run another
      // query when we're done.


      self._requeryWhenDoneThisQuery = true;
    });
  },
  // Yields!
  _doneQuerying: function () {
    var self = this;
    if (self._stopped) return;

    self._mongoHandle._oplogHandle.waitUntilCaughtUp(); // yields


    if (self._stopped) return;
    if (self._phase !== PHASE.QUERYING) throw Error("Phase unexpectedly " + self._phase);

    Meteor._noYieldsAllowed(function () {
      if (self._requeryWhenDoneThisQuery) {
        self._requeryWhenDoneThisQuery = false;

        self._pollQuery();
      } else if (self._needToFetch.empty()) {
        self._beSteady();
      } else {
        self._fetchModifiedDocuments();
      }
    });
  },
  _cursorForQuery: function (optionsOverwrite) {
    var self = this;
    return Meteor._noYieldsAllowed(function () {
      // The query we run is almost the same as the cursor we are observing,
      // with a few changes. We need to read all the fields that are relevant to
      // the selector, not just the fields we are going to publish (that's the
      // "shared" projection). And we don't want to apply any transform in the
      // cursor, because observeChanges shouldn't use the transform.
      var options = _.clone(self._cursorDescription.options); // Allow the caller to modify the options. Useful to specify different
      // skip and limit values.


      _.extend(options, optionsOverwrite);

      options.fields = self._sharedProjection;
      delete options.transform; // We are NOT deep cloning fields or selector here, which should be OK.

      var description = new CursorDescription(self._cursorDescription.collectionName, self._cursorDescription.selector, options);
      return new Cursor(self._mongoHandle, description);
    });
  },
  // Replace self._published with newResults (both are IdMaps), invoking observe
  // callbacks on the multiplexer.
  // Replace self._unpublishedBuffer with newBuffer.
  //
  // XXX This is very similar to LocalCollection._diffQueryUnorderedChanges. We
  // should really: (a) Unify IdMap and OrderedDict into Unordered/OrderedDict
  // (b) Rewrite diff.js to use these classes instead of arrays and objects.
  _publishNewResults: function (newResults, newBuffer) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      // If the query is limited and there is a buffer, shut down so it doesn't
      // stay in a way.
      if (self._limit) {
        self._unpublishedBuffer.clear();
      } // First remove anything that's gone. Be careful not to modify
      // self._published while iterating over it.


      var idsToRemove = [];

      self._published.forEach(function (doc, id) {
        if (!newResults.has(id)) idsToRemove.push(id);
      });

      _.each(idsToRemove, function (id) {
        self._removePublished(id);
      }); // Now do adds and changes.
      // If self has a buffer and limit, the new fetched result will be
      // limited correctly as the query has sort specifier.


      newResults.forEach(function (doc, id) {
        self._handleDoc(id, doc);
      }); // Sanity-check that everything we tried to put into _published ended up
      // there.
      // XXX if this is slow, remove it later

      if (self._published.size() !== newResults.size()) {
        console.error('The Mongo server and the Meteor query disagree on how ' + 'many documents match your query. Cursor description: ', self._cursorDescription);
        throw Error("The Mongo server and the Meteor query disagree on how " + "many documents match your query. Maybe it is hitting a Mongo " + "edge case? The query is: " + EJSON.stringify(self._cursorDescription.selector));
      }

      self._published.forEach(function (doc, id) {
        if (!newResults.has(id)) throw Error("_published has a doc that newResults doesn't; " + id);
      }); // Finally, replace the buffer


      newBuffer.forEach(function (doc, id) {
        self._addBuffered(id, doc);
      });
      self._safeAppendToBuffer = newBuffer.size() < self._limit;
    });
  },
  // This stop function is invoked from the onStop of the ObserveMultiplexer, so
  // it shouldn't actually be possible to call it until the multiplexer is
  // ready.
  //
  // It's important to check self._stopped after every call in this file that
  // can yield!
  stop: function () {
    var self = this;
    if (self._stopped) return;
    self._stopped = true;

    _.each(self._stopHandles, function (handle) {
      handle.stop();
    }); // Note: we *don't* use multiplexer.onFlush here because this stop
    // callback is actually invoked by the multiplexer itself when it has
    // determined that there are no handles left. So nothing is actually going
    // to get flushed (and it's probably not valid to call methods on the
    // dying multiplexer).


    _.each(self._writesToCommitWhenWeReachSteady, function (w) {
      w.committed(); // maybe yields?
    });

    self._writesToCommitWhenWeReachSteady = null; // Proactively drop references to potentially big things.

    self._published = null;
    self._unpublishedBuffer = null;
    self._needToFetch = null;
    self._currentlyFetching = null;
    self._oplogEntryHandle = null;
    self._listenersHandle = null;
    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-drivers-oplog", -1);
  },
  _registerPhaseChange: function (phase) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var now = new Date();

      if (self._phase) {
        var timeDiff = now - self._phaseStartTime;
        Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "time-spent-in-" + self._phase + "-phase", timeDiff);
      }

      self._phase = phase;
      self._phaseStartTime = now;
    });
  }
}); // Does our oplog tailing code support this cursor? For now, we are being very
// conservative and allowing only simple queries with simple options.
// (This is a "static method".)


OplogObserveDriver.cursorSupported = function (cursorDescription, matcher) {
  // First, check the options.
  var options = cursorDescription.options; // Did the user say no explicitly?
  // underscored version of the option is COMPAT with 1.2

  if (options.disableOplog || options._disableOplog) return false; // skip is not supported: to support it we would need to keep track of all
  // "skipped" documents or at least their ids.
  // limit w/o a sort specifier is not supported: current implementation needs a
  // deterministic way to order documents.

  if (options.skip || options.limit && !options.sort) return false; // If a fields projection option is given check if it is supported by
  // minimongo (some operators are not supported).

  if (options.fields) {
    try {
      LocalCollection._checkSupportedProjection(options.fields);
    } catch (e) {
      if (e.name === "MinimongoError") {
        return false;
      } else {
        throw e;
      }
    }
  } // We don't allow the following selectors:
  //   - $where (not confident that we provide the same JS environment
  //             as Mongo, and can yield!)
  //   - $near (has "interesting" properties in MongoDB, like the possibility
  //            of returning an ID multiple times, though even polling maybe
  //            have a bug there)
  //           XXX: once we support it, we would need to think more on how we
  //           initialize the comparators when we create the driver.


  return !matcher.hasWhere() && !matcher.hasGeoQuery();
};

var modifierCanBeDirectlyApplied = function (modifier) {
  return _.all(modifier, function (fields, operation) {
    return _.all(fields, function (value, field) {
      return !/EJSON\$/.test(field);
    });
  });
};

MongoInternals.OplogObserveDriver = OplogObserveDriver;
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"local_collection_driver.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/local_collection_driver.js                                                                           //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  LocalCollectionDriver: () => LocalCollectionDriver
});
const LocalCollectionDriver = new class LocalCollectionDriver {
  constructor() {
    this.noConnCollections = Object.create(null);
  }

  open(name, conn) {
    if (!name) {
      return new LocalCollection();
    }

    if (!conn) {
      return ensureCollection(name, this.noConnCollections);
    }

    if (!conn._mongo_livedata_collections) {
      conn._mongo_livedata_collections = Object.create(null);
    } // XXX is there a way to keep track of a connection's collections without
    // dangling it off the connection object?


    return ensureCollection(name, conn._mongo_livedata_collections);
  }

}();

function ensureCollection(name, collections) {
  return name in collections ? collections[name] : collections[name] = new LocalCollection(name);
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"remote_collection_driver.js":function module(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/remote_collection_driver.js                                                                          //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
MongoInternals.RemoteCollectionDriver = function (mongo_url, options) {
  var self = this;
  self.mongo = new MongoConnection(mongo_url, options);
};

_.extend(MongoInternals.RemoteCollectionDriver.prototype, {
  open: function (name) {
    var self = this;
    var ret = {};

    _.each(['find', 'findOne', 'insert', 'update', 'upsert', 'remove', '_ensureIndex', '_dropIndex', '_createCappedCollection', 'dropCollection', 'rawCollection'], function (m) {
      ret[m] = _.bind(self.mongo[m], self.mongo, name);
    });

    return ret;
  }
}); // Create the singleton RemoteCollectionDriver only on demand, so we
// only require Mongo configuration if it's actually used (eg, not if
// you're only trying to receive data from a remote DDP server.)


MongoInternals.defaultRemoteCollectionDriver = _.once(function () {
  var connectionOptions = {};
  var mongoUrl = process.env.MONGO_URL;

  if (process.env.MONGO_OPLOG_URL) {
    connectionOptions.oplogUrl = process.env.MONGO_OPLOG_URL;
  }

  if (!mongoUrl) throw new Error("MONGO_URL must be set in environment");
  return new MongoInternals.RemoteCollectionDriver(mongoUrl, connectionOptions);
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"collection.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/collection.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
!function (module1) {
  let _objectSpread;

  module1.link("@babel/runtime/helpers/objectSpread2", {
    default(v) {
      _objectSpread = v;
    }

  }, 0);
  // options.connection, if given, is a LivedataClient or LivedataServer
  // XXX presently there is no way to destroy/clean up a Collection

  /**
   * @summary Namespace for MongoDB-related items
   * @namespace
   */
  Mongo = {};
  /**
   * @summary Constructor for a Collection
   * @locus Anywhere
   * @instancename collection
   * @class
   * @param {String} name The name of the collection.  If null, creates an unmanaged (unsynchronized) local collection.
   * @param {Object} [options]
   * @param {Object} options.connection The server connection that will manage this collection. Uses the default connection if not specified.  Pass the return value of calling [`DDP.connect`](#ddp_connect) to specify a different server. Pass `null` to specify no connection. Unmanaged (`name` is null) collections cannot specify a connection.
   * @param {String} options.idGeneration The method of generating the `_id` fields of new documents in this collection.  Possible values:
  
   - **`'STRING'`**: random strings
   - **`'MONGO'`**:  random [`Mongo.ObjectID`](#mongo_object_id) values
  
  The default id generation technique is `'STRING'`.
   * @param {Function} options.transform An optional transformation function. Documents will be passed through this function before being returned from `fetch` or `findOne`, and before being passed to callbacks of `observe`, `map`, `forEach`, `allow`, and `deny`. Transforms are *not* applied for the callbacks of `observeChanges` or to cursors returned from publish functions.
   * @param {Boolean} options.defineMutationMethods Set to `false` to skip setting up the mutation methods that enable insert/update/remove from client code. Default `true`.
   */

  Mongo.Collection = function Collection(name, options) {
    if (!name && name !== null) {
      Meteor._debug("Warning: creating anonymous collection. It will not be " + "saved or synchronized over the network. (Pass null for " + "the collection name to turn off this warning.)");

      name = null;
    }

    if (name !== null && typeof name !== "string") {
      throw new Error("First argument to new Mongo.Collection must be a string or null");
    }

    if (options && options.methods) {
      // Backwards compatibility hack with original signature (which passed
      // "connection" directly instead of in options. (Connections must have a "methods"
      // method.)
      // XXX remove before 1.0
      options = {
        connection: options
      };
    } // Backwards compatibility: "connection" used to be called "manager".


    if (options && options.manager && !options.connection) {
      options.connection = options.manager;
    }

    options = _objectSpread({
      connection: undefined,
      idGeneration: 'STRING',
      transform: null,
      _driver: undefined,
      _preventAutopublish: false
    }, options);

    switch (options.idGeneration) {
      case 'MONGO':
        this._makeNewID = function () {
          var src = name ? DDP.randomStream('/collection/' + name) : Random.insecure;
          return new Mongo.ObjectID(src.hexString(24));
        };

        break;

      case 'STRING':
      default:
        this._makeNewID = function () {
          var src = name ? DDP.randomStream('/collection/' + name) : Random.insecure;
          return src.id();
        };

        break;
    }

    this._transform = LocalCollection.wrapTransform(options.transform);
    if (!name || options.connection === null) // note: nameless collections never have a connection
      this._connection = null;else if (options.connection) this._connection = options.connection;else if (Meteor.isClient) this._connection = Meteor.connection;else this._connection = Meteor.server;

    if (!options._driver) {
      // XXX This check assumes that webapp is loaded so that Meteor.server !==
      // null. We should fully support the case of "want to use a Mongo-backed
      // collection from Node code without webapp", but we don't yet.
      // #MeteorServerNull
      if (name && this._connection === Meteor.server && typeof MongoInternals !== "undefined" && MongoInternals.defaultRemoteCollectionDriver) {
        options._driver = MongoInternals.defaultRemoteCollectionDriver();
      } else {
        const {
          LocalCollectionDriver
        } = require("./local_collection_driver.js");

        options._driver = LocalCollectionDriver;
      }
    }

    this._collection = options._driver.open(name, this._connection);
    this._name = name;
    this._driver = options._driver;

    this._maybeSetUpReplication(name, options); // XXX don't define these until allow or deny is actually used for this
    // collection. Could be hard if the security rules are only defined on the
    // server.


    if (options.defineMutationMethods !== false) {
      try {
        this._defineMutationMethods({
          useExisting: options._suppressSameNameError === true
        });
      } catch (error) {
        // Throw a more understandable error on the server for same collection name
        if (error.message === "A method named '/".concat(name, "/insert' is already defined")) throw new Error("There is already a collection named \"".concat(name, "\""));
        throw error;
      }
    } // autopublish


    if (Package.autopublish && !options._preventAutopublish && this._connection && this._connection.publish) {
      this._connection.publish(null, () => this.find(), {
        is_auto: true
      });
    }
  };

  Object.assign(Mongo.Collection.prototype, {
    _maybeSetUpReplication(name, _ref) {
      let {
        _suppressSameNameError = false
      } = _ref;
      const self = this;

      if (!(self._connection && self._connection.registerStore)) {
        return;
      } // OK, we're going to be a slave, replicating some remote
      // database, except possibly with some temporary divergence while
      // we have unacknowledged RPC's.


      const ok = self._connection.registerStore(name, {
        // Called at the beginning of a batch of updates. batchSize is the number
        // of update calls to expect.
        //
        // XXX This interface is pretty janky. reset probably ought to go back to
        // being its own function, and callers shouldn't have to calculate
        // batchSize. The optimization of not calling pause/remove should be
        // delayed until later: the first call to update() should buffer its
        // message, and then we can either directly apply it at endUpdate time if
        // it was the only update, or do pauseObservers/apply/apply at the next
        // update() if there's another one.
        beginUpdate(batchSize, reset) {
          // pause observers so users don't see flicker when updating several
          // objects at once (including the post-reconnect reset-and-reapply
          // stage), and so that a re-sorting of a query can take advantage of the
          // full _diffQuery moved calculation instead of applying change one at a
          // time.
          if (batchSize > 1 || reset) self._collection.pauseObservers();
          if (reset) self._collection.remove({});
        },

        // Apply an update.
        // XXX better specify this interface (not in terms of a wire message)?
        update(msg) {
          var mongoId = MongoID.idParse(msg.id);

          var doc = self._collection.findOne(mongoId); // Is this a "replace the whole doc" message coming from the quiescence
          // of method writes to an object? (Note that 'undefined' is a valid
          // value meaning "remove it".)


          if (msg.msg === 'replace') {
            var replace = msg.replace;

            if (!replace) {
              if (doc) self._collection.remove(mongoId);
            } else if (!doc) {
              self._collection.insert(replace);
            } else {
              // XXX check that replace has no $ ops
              self._collection.update(mongoId, replace);
            }

            return;
          } else if (msg.msg === 'added') {
            if (doc) {
              throw new Error("Expected not to find a document already present for an add");
            }

            self._collection.insert(_objectSpread({
              _id: mongoId
            }, msg.fields));
          } else if (msg.msg === 'removed') {
            if (!doc) throw new Error("Expected to find a document already present for removed");

            self._collection.remove(mongoId);
          } else if (msg.msg === 'changed') {
            if (!doc) throw new Error("Expected to find a document to change");
            const keys = Object.keys(msg.fields);

            if (keys.length > 0) {
              var modifier = {};
              keys.forEach(key => {
                const value = msg.fields[key];

                if (EJSON.equals(doc[key], value)) {
                  return;
                }

                if (typeof value === "undefined") {
                  if (!modifier.$unset) {
                    modifier.$unset = {};
                  }

                  modifier.$unset[key] = 1;
                } else {
                  if (!modifier.$set) {
                    modifier.$set = {};
                  }

                  modifier.$set[key] = value;
                }
              });

              if (Object.keys(modifier).length > 0) {
                self._collection.update(mongoId, modifier);
              }
            }
          } else {
            throw new Error("I don't know how to deal with this message");
          }
        },

        // Called at the end of a batch of updates.
        endUpdate() {
          self._collection.resumeObservers();
        },

        // Called around method stub invocations to capture the original versions
        // of modified documents.
        saveOriginals() {
          self._collection.saveOriginals();
        },

        retrieveOriginals() {
          return self._collection.retrieveOriginals();
        },

        // Used to preserve current versions of documents across a store reset.
        getDoc(id) {
          return self.findOne(id);
        },

        // To be able to get back to the collection from the store.
        _getCollection() {
          return self;
        }

      });

      if (!ok) {
        const message = "There is already a collection named \"".concat(name, "\"");

        if (_suppressSameNameError === true) {
          // XXX In theory we do not have to throw when `ok` is falsy. The
          // store is already defined for this collection name, but this
          // will simply be another reference to it and everything should
          // work. However, we have historically thrown an error here, so
          // for now we will skip the error only when _suppressSameNameError
          // is `true`, allowing people to opt in and give this some real
          // world testing.
          console.warn ? console.warn(message) : console.log(message);
        } else {
          throw new Error(message);
        }
      }
    },

    ///
    /// Main collection API
    ///
    _getFindSelector(args) {
      if (args.length == 0) return {};else return args[0];
    },

    _getFindOptions(args) {
      var self = this;

      if (args.length < 2) {
        return {
          transform: self._transform
        };
      } else {
        check(args[1], Match.Optional(Match.ObjectIncluding({
          fields: Match.Optional(Match.OneOf(Object, undefined)),
          sort: Match.Optional(Match.OneOf(Object, Array, Function, undefined)),
          limit: Match.Optional(Match.OneOf(Number, undefined)),
          skip: Match.Optional(Match.OneOf(Number, undefined))
        })));
        return _objectSpread({
          transform: self._transform
        }, args[1]);
      }
    },

    /**
     * @summary Find the documents in a collection that match the selector.
     * @locus Anywhere
     * @method find
     * @memberof Mongo.Collection
     * @instance
     * @param {MongoSelector} [selector] A query describing the documents to find
     * @param {Object} [options]
     * @param {MongoSortSpecifier} options.sort Sort order (default: natural order)
     * @param {Number} options.skip Number of results to skip at the beginning
     * @param {Number} options.limit Maximum number of results to return
     * @param {MongoFieldSpecifier} options.fields Dictionary of fields to return or exclude.
     * @param {Boolean} options.reactive (Client only) Default `true`; pass `false` to disable reactivity
     * @param {Function} options.transform Overrides `transform` on the  [`Collection`](#collections) for this cursor.  Pass `null` to disable transformation.
     * @param {Boolean} options.disableOplog (Server only) Pass true to disable oplog-tailing on this query. This affects the way server processes calls to `observe` on this query. Disabling the oplog can be useful when working with data that updates in large batches.
     * @param {Number} options.pollingIntervalMs (Server only) When oplog is disabled (through the use of `disableOplog` or when otherwise not available), the frequency (in milliseconds) of how often to poll this query when observing on the server. Defaults to 10000ms (10 seconds).
     * @param {Number} options.pollingThrottleMs (Server only) When oplog is disabled (through the use of `disableOplog` or when otherwise not available), the minimum time (in milliseconds) to allow between re-polling when observing on the server. Increasing this will save CPU and mongo load at the expense of slower updates to users. Decreasing this is not recommended. Defaults to 50ms.
     * @param {Number} options.maxTimeMs (Server only) If set, instructs MongoDB to set a time limit for this cursor's operations. If the operation reaches the specified time limit (in milliseconds) without the having been completed, an exception will be thrown. Useful to prevent an (accidental or malicious) unoptimized query from causing a full collection scan that would disrupt other database users, at the expense of needing to handle the resulting error.
     * @param {String|Object} options.hint (Server only) Overrides MongoDB's default index selection and query optimization process. Specify an index to force its use, either by its name or index specification. You can also specify `{ $natural : 1 }` to force a forwards collection scan, or `{ $natural : -1 }` for a reverse collection scan. Setting this is only recommended for advanced users.
     * @returns {Mongo.Cursor}
     */
    find() {
      for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      // Collection.find() (return all docs) behaves differently
      // from Collection.find(undefined) (return 0 docs).  so be
      // careful about the length of arguments.
      return this._collection.find(this._getFindSelector(args), this._getFindOptions(args));
    },

    /**
     * @summary Finds the first document that matches the selector, as ordered by sort and skip options. Returns `undefined` if no matching document is found.
     * @locus Anywhere
     * @method findOne
     * @memberof Mongo.Collection
     * @instance
     * @param {MongoSelector} [selector] A query describing the documents to find
     * @param {Object} [options]
     * @param {MongoSortSpecifier} options.sort Sort order (default: natural order)
     * @param {Number} options.skip Number of results to skip at the beginning
     * @param {MongoFieldSpecifier} options.fields Dictionary of fields to return or exclude.
     * @param {Boolean} options.reactive (Client only) Default true; pass false to disable reactivity
     * @param {Function} options.transform Overrides `transform` on the [`Collection`](#collections) for this cursor.  Pass `null` to disable transformation.
     * @returns {Object}
     */
    findOne() {
      for (var _len2 = arguments.length, args = new Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
        args[_key2] = arguments[_key2];
      }

      return this._collection.findOne(this._getFindSelector(args), this._getFindOptions(args));
    }

  });
  Object.assign(Mongo.Collection, {
    _publishCursor(cursor, sub, collection) {
      var observeHandle = cursor.observeChanges({
        added: function (id, fields) {
          sub.added(collection, id, fields);
        },
        changed: function (id, fields) {
          sub.changed(collection, id, fields);
        },
        removed: function (id) {
          sub.removed(collection, id);
        }
      }); // We don't call sub.ready() here: it gets called in livedata_server, after
      // possibly calling _publishCursor on multiple returned cursors.
      // register stop callback (expects lambda w/ no args).

      sub.onStop(function () {
        observeHandle.stop();
      }); // return the observeHandle in case it needs to be stopped early

      return observeHandle;
    },

    // protect against dangerous selectors.  falsey and {_id: falsey} are both
    // likely programmer error, and not what you want, particularly for destructive
    // operations. If a falsey _id is sent in, a new string _id will be
    // generated and returned; if a fallbackId is provided, it will be returned
    // instead.
    _rewriteSelector(selector) {
      let {
        fallbackId
      } = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
      // shorthand -- scalars match _id
      if (LocalCollection._selectorIsId(selector)) selector = {
        _id: selector
      };

      if (Array.isArray(selector)) {
        // This is consistent with the Mongo console itself; if we don't do this
        // check passing an empty array ends up selecting all items
        throw new Error("Mongo selector can't be an array.");
      }

      if (!selector || '_id' in selector && !selector._id) {
        // can't match anything
        return {
          _id: fallbackId || Random.id()
        };
      }

      return selector;
    }

  });
  Object.assign(Mongo.Collection.prototype, {
    // 'insert' immediately returns the inserted document's new _id.
    // The others return values immediately if you are in a stub, an in-memory
    // unmanaged collection, or a mongo-backed collection and you don't pass a
    // callback. 'update' and 'remove' return the number of affected
    // documents. 'upsert' returns an object with keys 'numberAffected' and, if an
    // insert happened, 'insertedId'.
    //
    // Otherwise, the semantics are exactly like other methods: they take
    // a callback as an optional last argument; if no callback is
    // provided, they block until the operation is complete, and throw an
    // exception if it fails; if a callback is provided, then they don't
    // necessarily block, and they call the callback when they finish with error and
    // result arguments.  (The insert method provides the document ID as its result;
    // update and remove provide the number of affected docs as the result; upsert
    // provides an object with numberAffected and maybe insertedId.)
    //
    // On the client, blocking is impossible, so if a callback
    // isn't provided, they just return immediately and any error
    // information is lost.
    //
    // There's one more tweak. On the client, if you don't provide a
    // callback, then if there is an error, a message will be logged with
    // Meteor._debug.
    //
    // The intent (though this is actually determined by the underlying
    // drivers) is that the operations should be done synchronously, not
    // generating their result until the database has acknowledged
    // them. In the future maybe we should provide a flag to turn this
    // off.

    /**
     * @summary Insert a document in the collection.  Returns its unique _id.
     * @locus Anywhere
     * @method  insert
     * @memberof Mongo.Collection
     * @instance
     * @param {Object} doc The document to insert. May not yet have an _id attribute, in which case Meteor will generate one for you.
     * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the _id as the second.
     */
    insert(doc, callback) {
      // Make sure we were passed a document to insert
      if (!doc) {
        throw new Error("insert requires an argument");
      } // Make a shallow clone of the document, preserving its prototype.


      doc = Object.create(Object.getPrototypeOf(doc), Object.getOwnPropertyDescriptors(doc));

      if ('_id' in doc) {
        if (!doc._id || !(typeof doc._id === 'string' || doc._id instanceof Mongo.ObjectID)) {
          throw new Error("Meteor requires document _id fields to be non-empty strings or ObjectIDs");
        }
      } else {
        let generateId = true; // Don't generate the id if we're the client and the 'outermost' call
        // This optimization saves us passing both the randomSeed and the id
        // Passing both is redundant.

        if (this._isRemoteCollection()) {
          const enclosing = DDP._CurrentMethodInvocation.get();

          if (!enclosing) {
            generateId = false;
          }
        }

        if (generateId) {
          doc._id = this._makeNewID();
        }
      } // On inserts, always return the id that we generated; on all other
      // operations, just return the result from the collection.


      var chooseReturnValueFromCollectionResult = function (result) {
        if (doc._id) {
          return doc._id;
        } // XXX what is this for??
        // It's some iteraction between the callback to _callMutatorMethod and
        // the return value conversion


        doc._id = result;
        return result;
      };

      const wrappedCallback = wrapCallback(callback, chooseReturnValueFromCollectionResult);

      if (this._isRemoteCollection()) {
        const result = this._callMutatorMethod("insert", [doc], wrappedCallback);

        return chooseReturnValueFromCollectionResult(result);
      } // it's my collection.  descend into the collection object
      // and propagate any exception.


      try {
        // If the user provided a callback and the collection implements this
        // operation asynchronously, then queryRet will be undefined, and the
        // result will be returned through the callback instead.
        const result = this._collection.insert(doc, wrappedCallback);

        return chooseReturnValueFromCollectionResult(result);
      } catch (e) {
        if (callback) {
          callback(e);
          return null;
        }

        throw e;
      }
    },

    /**
     * @summary Modify one or more documents in the collection. Returns the number of matched documents.
     * @locus Anywhere
     * @method update
     * @memberof Mongo.Collection
     * @instance
     * @param {MongoSelector} selector Specifies which documents to modify
     * @param {MongoModifier} modifier Specifies how to modify the documents
     * @param {Object} [options]
     * @param {Boolean} options.multi True to modify all matching documents; false to only modify one of the matching documents (the default).
     * @param {Boolean} options.upsert True to insert a document if no matching documents are found.
     * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the number of affected documents as the second.
     */
    update(selector, modifier) {
      for (var _len3 = arguments.length, optionsAndCallback = new Array(_len3 > 2 ? _len3 - 2 : 0), _key3 = 2; _key3 < _len3; _key3++) {
        optionsAndCallback[_key3 - 2] = arguments[_key3];
      }

      const callback = popCallbackFromArgs(optionsAndCallback); // We've already popped off the callback, so we are left with an array
      // of one or zero items

      const options = _objectSpread({}, optionsAndCallback[0] || null);

      let insertedId;

      if (options && options.upsert) {
        // set `insertedId` if absent.  `insertedId` is a Meteor extension.
        if (options.insertedId) {
          if (!(typeof options.insertedId === 'string' || options.insertedId instanceof Mongo.ObjectID)) throw new Error("insertedId must be string or ObjectID");
          insertedId = options.insertedId;
        } else if (!selector || !selector._id) {
          insertedId = this._makeNewID();
          options.generatedId = true;
          options.insertedId = insertedId;
        }
      }

      selector = Mongo.Collection._rewriteSelector(selector, {
        fallbackId: insertedId
      });
      const wrappedCallback = wrapCallback(callback);

      if (this._isRemoteCollection()) {
        const args = [selector, modifier, options];
        return this._callMutatorMethod("update", args, wrappedCallback);
      } // it's my collection.  descend into the collection object
      // and propagate any exception.


      try {
        // If the user provided a callback and the collection implements this
        // operation asynchronously, then queryRet will be undefined, and the
        // result will be returned through the callback instead.
        return this._collection.update(selector, modifier, options, wrappedCallback);
      } catch (e) {
        if (callback) {
          callback(e);
          return null;
        }

        throw e;
      }
    },

    /**
     * @summary Remove documents from the collection
     * @locus Anywhere
     * @method remove
     * @memberof Mongo.Collection
     * @instance
     * @param {MongoSelector} selector Specifies which documents to remove
     * @param {Function} [callback] Optional.  If present, called with an error object as its argument.
     */
    remove(selector, callback) {
      selector = Mongo.Collection._rewriteSelector(selector);
      const wrappedCallback = wrapCallback(callback);

      if (this._isRemoteCollection()) {
        return this._callMutatorMethod("remove", [selector], wrappedCallback);
      } // it's my collection.  descend into the collection object
      // and propagate any exception.


      try {
        // If the user provided a callback and the collection implements this
        // operation asynchronously, then queryRet will be undefined, and the
        // result will be returned through the callback instead.
        return this._collection.remove(selector, wrappedCallback);
      } catch (e) {
        if (callback) {
          callback(e);
          return null;
        }

        throw e;
      }
    },

    // Determine if this collection is simply a minimongo representation of a real
    // database on another server
    _isRemoteCollection() {
      // XXX see #MeteorServerNull
      return this._connection && this._connection !== Meteor.server;
    },

    /**
     * @summary Modify one or more documents in the collection, or insert one if no matching documents were found. Returns an object with keys `numberAffected` (the number of documents modified)  and `insertedId` (the unique _id of the document that was inserted, if any).
     * @locus Anywhere
     * @method upsert
     * @memberof Mongo.Collection
     * @instance
     * @param {MongoSelector} selector Specifies which documents to modify
     * @param {MongoModifier} modifier Specifies how to modify the documents
     * @param {Object} [options]
     * @param {Boolean} options.multi True to modify all matching documents; false to only modify one of the matching documents (the default).
     * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the number of affected documents as the second.
     */
    upsert(selector, modifier, options, callback) {
      if (!callback && typeof options === "function") {
        callback = options;
        options = {};
      }

      return this.update(selector, modifier, _objectSpread({}, options, {
        _returnObject: true,
        upsert: true
      }), callback);
    },

    // We'll actually design an index API later. For now, we just pass through to
    // Mongo's, but make it synchronous.
    _ensureIndex(index, options) {
      var self = this;
      if (!self._collection._ensureIndex) throw new Error("Can only call _ensureIndex on server collections");

      self._collection._ensureIndex(index, options);
    },

    _dropIndex(index) {
      var self = this;
      if (!self._collection._dropIndex) throw new Error("Can only call _dropIndex on server collections");

      self._collection._dropIndex(index);
    },

    _dropCollection() {
      var self = this;
      if (!self._collection.dropCollection) throw new Error("Can only call _dropCollection on server collections");

      self._collection.dropCollection();
    },

    _createCappedCollection(byteSize, maxDocuments) {
      var self = this;
      if (!self._collection._createCappedCollection) throw new Error("Can only call _createCappedCollection on server collections");

      self._collection._createCappedCollection(byteSize, maxDocuments);
    },

    /**
     * @summary Returns the [`Collection`](http://mongodb.github.io/node-mongodb-native/3.0/api/Collection.html) object corresponding to this collection from the [npm `mongodb` driver module](https://www.npmjs.com/package/mongodb) which is wrapped by `Mongo.Collection`.
     * @locus Server
     * @memberof Mongo.Collection
     * @instance
     */
    rawCollection() {
      var self = this;

      if (!self._collection.rawCollection) {
        throw new Error("Can only call rawCollection on server collections");
      }

      return self._collection.rawCollection();
    },

    /**
     * @summary Returns the [`Db`](http://mongodb.github.io/node-mongodb-native/3.0/api/Db.html) object corresponding to this collection's database connection from the [npm `mongodb` driver module](https://www.npmjs.com/package/mongodb) which is wrapped by `Mongo.Collection`.
     * @locus Server
     * @memberof Mongo.Collection
     * @instance
     */
    rawDatabase() {
      var self = this;

      if (!(self._driver.mongo && self._driver.mongo.db)) {
        throw new Error("Can only call rawDatabase on server collections");
      }

      return self._driver.mongo.db;
    }

  }); // Convert the callback to not return a result if there is an error

  function wrapCallback(callback, convertResult) {
    return callback && function (error, result) {
      if (error) {
        callback(error);
      } else if (typeof convertResult === "function") {
        callback(error, convertResult(result));
      } else {
        callback(error, result);
      }
    };
  }
  /**
   * @summary Create a Mongo-style `ObjectID`.  If you don't specify a `hexString`, the `ObjectID` will generated randomly (not using MongoDB's ID construction rules).
   * @locus Anywhere
   * @class
   * @param {String} [hexString] Optional.  The 24-character hexadecimal contents of the ObjectID to create
   */


  Mongo.ObjectID = MongoID.ObjectID;
  /**
   * @summary To create a cursor, use find. To access the documents in a cursor, use forEach, map, or fetch.
   * @class
   * @instanceName cursor
   */

  Mongo.Cursor = LocalCollection.Cursor;
  /**
   * @deprecated in 0.9.1
   */

  Mongo.Collection.Cursor = Mongo.Cursor;
  /**
   * @deprecated in 0.9.1
   */

  Mongo.Collection.ObjectID = Mongo.ObjectID;
  /**
   * @deprecated in 0.9.1
   */

  Meteor.Collection = Mongo.Collection; // Allow deny stuff is now in the allow-deny package

  Object.assign(Meteor.Collection.prototype, AllowDeny.CollectionPrototype);

  function popCallbackFromArgs(args) {
    // Pull off any callback (or perhaps a 'callback' variable that was passed
    // in undefined, like how 'upsert' does it).
    if (args.length && (args[args.length - 1] === undefined || args[args.length - 1] instanceof Function)) {
      return args.pop();
    }
  }
}.call(this, module);
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"connection_options.js":function module(){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/connection_options.js                                                                                //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
/**
 * @summary Allows for user specified connection options
 * @example http://mongodb.github.io/node-mongodb-native/3.0/reference/connecting/connection-settings/
 * @locus Server
 * @param {Object} options User specified Mongo connection options
 */
Mongo.setConnectionOptions = function setConnectionOptions(options) {
  check(options, Object);
  Mongo._connectionOptions = options;
};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}}}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});

require("/node_modules/meteor/mongo/mongo_driver.js");
require("/node_modules/meteor/mongo/oplog_tailing.js");
require("/node_modules/meteor/mongo/observe_multiplex.js");
require("/node_modules/meteor/mongo/doc_fetcher.js");
require("/node_modules/meteor/mongo/polling_observe_driver.js");
require("/node_modules/meteor/mongo/oplog_observe_driver.js");
require("/node_modules/meteor/mongo/local_collection_driver.js");
require("/node_modules/meteor/mongo/remote_collection_driver.js");
require("/node_modules/meteor/mongo/collection.js");
require("/node_modules/meteor/mongo/connection_options.js");

/* Exports */
Package._define("mongo", {
  MongoInternals: MongoInternals,
  Mongo: Mongo
});

})();

//# sourceURL=meteor://💻app/packages/mongo.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbW9uZ28vbW9uZ29fZHJpdmVyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9vcGxvZ190YWlsaW5nLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9vYnNlcnZlX211bHRpcGxleC5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbW9uZ28vZG9jX2ZldGNoZXIuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21vbmdvL3BvbGxpbmdfb2JzZXJ2ZV9kcml2ZXIuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21vbmdvL29wbG9nX29ic2VydmVfZHJpdmVyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9sb2NhbF9jb2xsZWN0aW9uX2RyaXZlci5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbW9uZ28vcmVtb3RlX2NvbGxlY3Rpb25fZHJpdmVyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9jb2xsZWN0aW9uLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9jb25uZWN0aW9uX29wdGlvbnMuanMiXSwibmFtZXMiOlsiRG9jRmV0Y2hlciIsIm1vZHVsZTEiLCJsaW5rIiwidiIsIk1vbmdvREIiLCJOcG1Nb2R1bGVNb25nb2RiIiwiRnV0dXJlIiwiTnBtIiwicmVxdWlyZSIsIk1vbmdvSW50ZXJuYWxzIiwiTnBtTW9kdWxlcyIsIm1vbmdvZGIiLCJ2ZXJzaW9uIiwiTnBtTW9kdWxlTW9uZ29kYlZlcnNpb24iLCJtb2R1bGUiLCJOcG1Nb2R1bGUiLCJyZXBsYWNlTmFtZXMiLCJmaWx0ZXIiLCJ0aGluZyIsIl8iLCJpc0FycmF5IiwibWFwIiwiYmluZCIsInJldCIsImVhY2giLCJ2YWx1ZSIsImtleSIsIlRpbWVzdGFtcCIsInByb3RvdHlwZSIsImNsb25lIiwibWFrZU1vbmdvTGVnYWwiLCJuYW1lIiwidW5tYWtlTW9uZ29MZWdhbCIsInN1YnN0ciIsInJlcGxhY2VNb25nb0F0b21XaXRoTWV0ZW9yIiwiZG9jdW1lbnQiLCJCaW5hcnkiLCJidWZmZXIiLCJVaW50OEFycmF5IiwiT2JqZWN0SUQiLCJNb25nbyIsInRvSGV4U3RyaW5nIiwiRGVjaW1hbDEyOCIsIkRlY2ltYWwiLCJ0b1N0cmluZyIsInNpemUiLCJFSlNPTiIsImZyb21KU09OVmFsdWUiLCJ1bmRlZmluZWQiLCJyZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyIsImlzQmluYXJ5IiwiZnJvbVN0cmluZyIsIl9pc0N1c3RvbVR5cGUiLCJ0b0pTT05WYWx1ZSIsInJlcGxhY2VUeXBlcyIsImF0b21UcmFuc2Zvcm1lciIsInJlcGxhY2VkVG9wTGV2ZWxBdG9tIiwidmFsIiwidmFsUmVwbGFjZWQiLCJNb25nb0Nvbm5lY3Rpb24iLCJ1cmwiLCJvcHRpb25zIiwic2VsZiIsIl9vYnNlcnZlTXVsdGlwbGV4ZXJzIiwiX29uRmFpbG92ZXJIb29rIiwiSG9vayIsIm1vbmdvT3B0aW9ucyIsIk9iamVjdCIsImFzc2lnbiIsImF1dG9SZWNvbm5lY3QiLCJyZWNvbm5lY3RUcmllcyIsIkluZmluaXR5IiwiaWdub3JlVW5kZWZpbmVkIiwidXNlTmV3VXJsUGFyc2VyIiwiX2Nvbm5lY3Rpb25PcHRpb25zIiwidGVzdCIsIm5hdGl2ZV9wYXJzZXIiLCJoYXMiLCJwb29sU2l6ZSIsImRiIiwiX3ByaW1hcnkiLCJfb3Bsb2dIYW5kbGUiLCJfZG9jRmV0Y2hlciIsImNvbm5lY3RGdXR1cmUiLCJjb25uZWN0IiwiTWV0ZW9yIiwiYmluZEVudmlyb25tZW50IiwiZXJyIiwiY2xpZW50Iiwic2VydmVyQ29uZmlnIiwiaXNNYXN0ZXJEb2MiLCJwcmltYXJ5Iiwib24iLCJraW5kIiwiZG9jIiwiY2FsbGJhY2siLCJtZSIsInJlc29sdmVyIiwid2FpdCIsIm9wbG9nVXJsIiwiUGFja2FnZSIsIk9wbG9nSGFuZGxlIiwiZGF0YWJhc2VOYW1lIiwiY2xvc2UiLCJFcnJvciIsIm9wbG9nSGFuZGxlIiwic3RvcCIsIndyYXAiLCJyYXdDb2xsZWN0aW9uIiwiY29sbGVjdGlvbk5hbWUiLCJmdXR1cmUiLCJjb2xsZWN0aW9uIiwiX2NyZWF0ZUNhcHBlZENvbGxlY3Rpb24iLCJieXRlU2l6ZSIsIm1heERvY3VtZW50cyIsImNyZWF0ZUNvbGxlY3Rpb24iLCJjYXBwZWQiLCJtYXgiLCJfbWF5YmVCZWdpbldyaXRlIiwiZmVuY2UiLCJERFBTZXJ2ZXIiLCJfQ3VycmVudFdyaXRlRmVuY2UiLCJnZXQiLCJiZWdpbldyaXRlIiwiY29tbWl0dGVkIiwiX29uRmFpbG92ZXIiLCJyZWdpc3RlciIsIndyaXRlQ2FsbGJhY2siLCJ3cml0ZSIsInJlZnJlc2giLCJyZXN1bHQiLCJyZWZyZXNoRXJyIiwiYmluZEVudmlyb25tZW50Rm9yV3JpdGUiLCJfaW5zZXJ0IiwiY29sbGVjdGlvbl9uYW1lIiwic2VuZEVycm9yIiwiZSIsIl9leHBlY3RlZEJ5VGVzdCIsIkxvY2FsQ29sbGVjdGlvbiIsIl9pc1BsYWluT2JqZWN0IiwiaWQiLCJfaWQiLCJpbnNlcnQiLCJzYWZlIiwiX3JlZnJlc2giLCJzZWxlY3RvciIsInJlZnJlc2hLZXkiLCJzcGVjaWZpY0lkcyIsIl9pZHNNYXRjaGVkQnlTZWxlY3RvciIsImV4dGVuZCIsIl9yZW1vdmUiLCJ3cmFwcGVkQ2FsbGJhY2siLCJkcml2ZXJSZXN1bHQiLCJ0cmFuc2Zvcm1SZXN1bHQiLCJudW1iZXJBZmZlY3RlZCIsInJlbW92ZSIsIl9kcm9wQ29sbGVjdGlvbiIsImNiIiwiZHJvcENvbGxlY3Rpb24iLCJkcm9wIiwiX2Ryb3BEYXRhYmFzZSIsImRyb3BEYXRhYmFzZSIsIl91cGRhdGUiLCJtb2QiLCJGdW5jdGlvbiIsIm1vbmdvT3B0cyIsInVwc2VydCIsIm11bHRpIiwiZnVsbFJlc3VsdCIsIm1vbmdvU2VsZWN0b3IiLCJtb25nb01vZCIsImlzTW9kaWZ5IiwiX2lzTW9kaWZpY2F0aW9uTW9kIiwiX2ZvcmJpZFJlcGxhY2UiLCJrbm93bklkIiwibmV3RG9jIiwiX2NyZWF0ZVVwc2VydERvY3VtZW50IiwiaW5zZXJ0ZWRJZCIsImdlbmVyYXRlZElkIiwic2ltdWxhdGVVcHNlcnRXaXRoSW5zZXJ0ZWRJZCIsImVycm9yIiwiX3JldHVybk9iamVjdCIsImhhc093blByb3BlcnR5IiwiJHNldE9uSW5zZXJ0IiwidXBkYXRlIiwibWV0ZW9yUmVzdWx0IiwibW9uZ29SZXN1bHQiLCJ1cHNlcnRlZCIsImxlbmd0aCIsIm4iLCJOVU1fT1BUSU1JU1RJQ19UUklFUyIsIl9pc0Nhbm5vdENoYW5nZUlkRXJyb3IiLCJlcnJtc2ciLCJpbmRleE9mIiwibW9uZ29PcHRzRm9yVXBkYXRlIiwibW9uZ29PcHRzRm9ySW5zZXJ0IiwicmVwbGFjZW1lbnRXaXRoSWQiLCJ0cmllcyIsImRvVXBkYXRlIiwiZG9Db25kaXRpb25hbEluc2VydCIsIm1ldGhvZCIsIndyYXBBc3luYyIsImFwcGx5IiwiYXJndW1lbnRzIiwiZmluZCIsIkN1cnNvciIsIkN1cnNvckRlc2NyaXB0aW9uIiwiZmluZE9uZSIsImxpbWl0IiwiZmV0Y2giLCJfZW5zdXJlSW5kZXgiLCJpbmRleCIsImluZGV4TmFtZSIsImVuc3VyZUluZGV4IiwiRXhjZXB0aW9uIiwiX2Ryb3BJbmRleCIsImRyb3BJbmRleCIsIkNvbGxlY3Rpb24iLCJfcmV3cml0ZVNlbGVjdG9yIiwibW9uZ28iLCJjdXJzb3JEZXNjcmlwdGlvbiIsIl9tb25nbyIsIl9jdXJzb3JEZXNjcmlwdGlvbiIsIl9zeW5jaHJvbm91c0N1cnNvciIsIlN5bWJvbCIsIml0ZXJhdG9yIiwidGFpbGFibGUiLCJfY3JlYXRlU3luY2hyb25vdXNDdXJzb3IiLCJzZWxmRm9ySXRlcmF0aW9uIiwidXNlVHJhbnNmb3JtIiwicmV3aW5kIiwiZ2V0VHJhbnNmb3JtIiwidHJhbnNmb3JtIiwiX3B1Ymxpc2hDdXJzb3IiLCJzdWIiLCJfZ2V0Q29sbGVjdGlvbk5hbWUiLCJvYnNlcnZlIiwiY2FsbGJhY2tzIiwiX29ic2VydmVGcm9tT2JzZXJ2ZUNoYW5nZXMiLCJvYnNlcnZlQ2hhbmdlcyIsIm1ldGhvZHMiLCJvcmRlcmVkIiwiX29ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzQXJlT3JkZXJlZCIsImV4Y2VwdGlvbk5hbWUiLCJmb3JFYWNoIiwiX29ic2VydmVDaGFuZ2VzIiwicGljayIsImN1cnNvck9wdGlvbnMiLCJzb3J0Iiwic2tpcCIsInByb2plY3Rpb24iLCJmaWVsZHMiLCJhd2FpdGRhdGEiLCJudW1iZXJPZlJldHJpZXMiLCJPUExPR19DT0xMRUNUSU9OIiwidHMiLCJvcGxvZ1JlcGxheSIsImRiQ3Vyc29yIiwibWF4VGltZU1zIiwibWF4VGltZU1TIiwiaGludCIsIlN5bmNocm9ub3VzQ3Vyc29yIiwiX2RiQ3Vyc29yIiwiX3NlbGZGb3JJdGVyYXRpb24iLCJfdHJhbnNmb3JtIiwid3JhcFRyYW5zZm9ybSIsIl9zeW5jaHJvbm91c0NvdW50IiwiY291bnQiLCJfdmlzaXRlZElkcyIsIl9JZE1hcCIsIl9yYXdOZXh0T2JqZWN0UHJvbWlzZSIsIlByb21pc2UiLCJyZXNvbHZlIiwicmVqZWN0IiwibmV4dCIsIl9uZXh0T2JqZWN0UHJvbWlzZSIsInNldCIsIl9uZXh0T2JqZWN0UHJvbWlzZVdpdGhUaW1lb3V0IiwidGltZW91dE1TIiwibmV4dE9iamVjdFByb21pc2UiLCJ0aW1lb3V0RXJyIiwidGltZW91dFByb21pc2UiLCJ0aW1lciIsInNldFRpbWVvdXQiLCJyYWNlIiwiY2F0Y2giLCJfbmV4dE9iamVjdCIsImF3YWl0IiwidGhpc0FyZyIsIl9yZXdpbmQiLCJjYWxsIiwicmVzIiwicHVzaCIsImlkZW50aXR5IiwiYXBwbHlTa2lwTGltaXQiLCJnZXRSYXdPYmplY3RzIiwicmVzdWx0cyIsImRvbmUiLCJ0YWlsIiwiZG9jQ2FsbGJhY2siLCJjdXJzb3IiLCJzdG9wcGVkIiwibGFzdFRTIiwibG9vcCIsIm5ld1NlbGVjdG9yIiwiJGd0IiwiZGVmZXIiLCJfb2JzZXJ2ZUNoYW5nZXNUYWlsYWJsZSIsIm9ic2VydmVLZXkiLCJzdHJpbmdpZnkiLCJtdWx0aXBsZXhlciIsIm9ic2VydmVEcml2ZXIiLCJmaXJzdEhhbmRsZSIsIl9ub1lpZWxkc0FsbG93ZWQiLCJPYnNlcnZlTXVsdGlwbGV4ZXIiLCJvblN0b3AiLCJvYnNlcnZlSGFuZGxlIiwiT2JzZXJ2ZUhhbmRsZSIsIm1hdGNoZXIiLCJzb3J0ZXIiLCJjYW5Vc2VPcGxvZyIsImFsbCIsIl90ZXN0T25seVBvbGxDYWxsYmFjayIsIk1pbmltb25nbyIsIk1hdGNoZXIiLCJPcGxvZ09ic2VydmVEcml2ZXIiLCJjdXJzb3JTdXBwb3J0ZWQiLCJTb3J0ZXIiLCJmIiwiZHJpdmVyQ2xhc3MiLCJQb2xsaW5nT2JzZXJ2ZURyaXZlciIsIm1vbmdvSGFuZGxlIiwiX29ic2VydmVEcml2ZXIiLCJhZGRIYW5kbGVBbmRTZW5kSW5pdGlhbEFkZHMiLCJsaXN0ZW5BbGwiLCJsaXN0ZW5DYWxsYmFjayIsImxpc3RlbmVycyIsImZvckVhY2hUcmlnZ2VyIiwidHJpZ2dlciIsIl9JbnZhbGlkYXRpb25Dcm9zc2JhciIsImxpc3RlbiIsImxpc3RlbmVyIiwidHJpZ2dlckNhbGxiYWNrIiwiYWRkZWRCZWZvcmUiLCJhZGRlZCIsIk1vbmdvVGltZXN0YW1wIiwiQ29ubmVjdGlvbiIsIlRPT19GQVJfQkVISU5EIiwicHJvY2VzcyIsImVudiIsIk1FVEVPUl9PUExPR19UT09fRkFSX0JFSElORCIsIlRBSUxfVElNRU9VVCIsIk1FVEVPUl9PUExPR19UQUlMX1RJTUVPVVQiLCJzaG93VFMiLCJnZXRIaWdoQml0cyIsImdldExvd0JpdHMiLCJpZEZvck9wIiwib3AiLCJvIiwibzIiLCJkYk5hbWUiLCJfb3Bsb2dVcmwiLCJfZGJOYW1lIiwiX29wbG9nTGFzdEVudHJ5Q29ubmVjdGlvbiIsIl9vcGxvZ1RhaWxDb25uZWN0aW9uIiwiX3N0b3BwZWQiLCJfdGFpbEhhbmRsZSIsIl9yZWFkeUZ1dHVyZSIsIl9jcm9zc2JhciIsIl9Dcm9zc2JhciIsImZhY3RQYWNrYWdlIiwiZmFjdE5hbWUiLCJfYmFzZU9wbG9nU2VsZWN0b3IiLCJucyIsIlJlZ0V4cCIsIl9lc2NhcGVSZWdFeHAiLCJqb2luIiwiJG9yIiwiJGluIiwiJGV4aXN0cyIsIl9jYXRjaGluZ1VwRnV0dXJlcyIsIl9sYXN0UHJvY2Vzc2VkVFMiLCJfb25Ta2lwcGVkRW50cmllc0hvb2siLCJkZWJ1Z1ByaW50RXhjZXB0aW9ucyIsIl9lbnRyeVF1ZXVlIiwiX0RvdWJsZUVuZGVkUXVldWUiLCJfd29ya2VyQWN0aXZlIiwiX3N0YXJ0VGFpbGluZyIsIm9uT3Bsb2dFbnRyeSIsIm9yaWdpbmFsQ2FsbGJhY2siLCJub3RpZmljYXRpb24iLCJfZGVidWciLCJsaXN0ZW5IYW5kbGUiLCJvblNraXBwZWRFbnRyaWVzIiwid2FpdFVudGlsQ2F1Z2h0VXAiLCJsYXN0RW50cnkiLCIkbmF0dXJhbCIsIl9zbGVlcEZvck1zIiwibGVzc1RoYW5PckVxdWFsIiwiaW5zZXJ0QWZ0ZXIiLCJncmVhdGVyVGhhbiIsInNwbGljZSIsIm1vbmdvZGJVcmkiLCJwYXJzZSIsImRhdGFiYXNlIiwiYWRtaW4iLCJjb21tYW5kIiwiaXNtYXN0ZXIiLCJzZXROYW1lIiwibGFzdE9wbG9nRW50cnkiLCJvcGxvZ1NlbGVjdG9yIiwiX21heWJlU3RhcnRXb3JrZXIiLCJyZXR1cm4iLCJoYW5kbGVEb2MiLCJhcHBseU9wcyIsIm5leHRUaW1lc3RhbXAiLCJhZGQiLCJPTkUiLCJzdGFydHNXaXRoIiwic2xpY2UiLCJmaXJlIiwiaXNFbXB0eSIsInBvcCIsImNsZWFyIiwiX3NldExhc3RQcm9jZXNzZWRUUyIsInNoaWZ0Iiwic2VxdWVuY2VyIiwiX2RlZmluZVRvb0ZhckJlaGluZCIsIl9yZXNldFRvb0ZhckJlaGluZCIsIkZhY3RzIiwiaW5jcmVtZW50U2VydmVyRmFjdCIsIl9vcmRlcmVkIiwiX29uU3RvcCIsIl9xdWV1ZSIsIl9TeW5jaHJvbm91c1F1ZXVlIiwiX2hhbmRsZXMiLCJfY2FjaGUiLCJfQ2FjaGluZ0NoYW5nZU9ic2VydmVyIiwiX2FkZEhhbmRsZVRhc2tzU2NoZWR1bGVkQnV0Tm90UGVyZm9ybWVkIiwiY2FsbGJhY2tOYW1lcyIsImNhbGxiYWNrTmFtZSIsIl9hcHBseUNhbGxiYWNrIiwidG9BcnJheSIsImhhbmRsZSIsInNhZmVUb1J1blRhc2siLCJydW5UYXNrIiwiX3NlbmRBZGRzIiwicmVtb3ZlSGFuZGxlIiwiX3JlYWR5IiwiX3N0b3AiLCJmcm9tUXVlcnlFcnJvciIsInJlYWR5IiwicXVldWVUYXNrIiwicXVlcnlFcnJvciIsInRocm93Iiwib25GbHVzaCIsImlzUmVzb2x2ZWQiLCJhcmdzIiwiYXBwbHlDaGFuZ2UiLCJrZXlzIiwiaGFuZGxlSWQiLCJfYWRkZWRCZWZvcmUiLCJfYWRkZWQiLCJkb2NzIiwibmV4dE9ic2VydmVIYW5kbGVJZCIsIl9tdWx0aXBsZXhlciIsImJlZm9yZSIsImV4cG9ydCIsIkZpYmVyIiwiY29uc3RydWN0b3IiLCJtb25nb0Nvbm5lY3Rpb24iLCJfbW9uZ29Db25uZWN0aW9uIiwiX2NhbGxiYWNrc0Zvck9wIiwiTWFwIiwiY2hlY2siLCJTdHJpbmciLCJkZWxldGUiLCJydW4iLCJQT0xMSU5HX1RIUk9UVExFX01TIiwiTUVURU9SX1BPTExJTkdfVEhST1RUTEVfTVMiLCJQT0xMSU5HX0lOVEVSVkFMX01TIiwiTUVURU9SX1BPTExJTkdfSU5URVJWQUxfTVMiLCJfbW9uZ29IYW5kbGUiLCJfc3RvcENhbGxiYWNrcyIsIl9yZXN1bHRzIiwiX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCIsIl9wZW5kaW5nV3JpdGVzIiwiX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCIsInRocm90dGxlIiwiX3VudGhyb3R0bGVkRW5zdXJlUG9sbElzU2NoZWR1bGVkIiwicG9sbGluZ1Rocm90dGxlTXMiLCJfdGFza1F1ZXVlIiwibGlzdGVuZXJzSGFuZGxlIiwicG9sbGluZ0ludGVydmFsIiwicG9sbGluZ0ludGVydmFsTXMiLCJfcG9sbGluZ0ludGVydmFsIiwiaW50ZXJ2YWxIYW5kbGUiLCJzZXRJbnRlcnZhbCIsImNsZWFySW50ZXJ2YWwiLCJfcG9sbE1vbmdvIiwiX3N1c3BlbmRQb2xsaW5nIiwiX3Jlc3VtZVBvbGxpbmciLCJmaXJzdCIsIm5ld1Jlc3VsdHMiLCJvbGRSZXN1bHRzIiwid3JpdGVzRm9yQ3ljbGUiLCJjb2RlIiwiSlNPTiIsIm1lc3NhZ2UiLCJBcnJheSIsIl9kaWZmUXVlcnlDaGFuZ2VzIiwidyIsImMiLCJQSEFTRSIsIlFVRVJZSU5HIiwiRkVUQ0hJTkciLCJTVEVBRFkiLCJTd2l0Y2hlZFRvUXVlcnkiLCJmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeSIsImN1cnJlbnRJZCIsIl91c2VzT3Bsb2ciLCJjb21wYXJhdG9yIiwiZ2V0Q29tcGFyYXRvciIsImhlYXBPcHRpb25zIiwiSWRNYXAiLCJfbGltaXQiLCJfY29tcGFyYXRvciIsIl9zb3J0ZXIiLCJfdW5wdWJsaXNoZWRCdWZmZXIiLCJNaW5NYXhIZWFwIiwiX3B1Ymxpc2hlZCIsIk1heEhlYXAiLCJfc2FmZUFwcGVuZFRvQnVmZmVyIiwiX3N0b3BIYW5kbGVzIiwiX3JlZ2lzdGVyUGhhc2VDaGFuZ2UiLCJfbWF0Y2hlciIsIl9wcm9qZWN0aW9uRm4iLCJfY29tcGlsZVByb2plY3Rpb24iLCJfc2hhcmVkUHJvamVjdGlvbiIsImNvbWJpbmVJbnRvUHJvamVjdGlvbiIsIl9zaGFyZWRQcm9qZWN0aW9uRm4iLCJfbmVlZFRvRmV0Y2giLCJfY3VycmVudGx5RmV0Y2hpbmciLCJfZmV0Y2hHZW5lcmF0aW9uIiwiX3JlcXVlcnlXaGVuRG9uZVRoaXNRdWVyeSIsIl93cml0ZXNUb0NvbW1pdFdoZW5XZVJlYWNoU3RlYWR5IiwiX25lZWRUb1BvbGxRdWVyeSIsIl9waGFzZSIsIl9oYW5kbGVPcGxvZ0VudHJ5UXVlcnlpbmciLCJfaGFuZGxlT3Bsb2dFbnRyeVN0ZWFkeU9yRmV0Y2hpbmciLCJmaXJlZCIsIl9vcGxvZ09ic2VydmVEcml2ZXJzIiwib25CZWZvcmVGaXJlIiwiZHJpdmVycyIsImRyaXZlciIsIl9ydW5Jbml0aWFsUXVlcnkiLCJfYWRkUHVibGlzaGVkIiwib3ZlcmZsb3dpbmdEb2NJZCIsIm1heEVsZW1lbnRJZCIsIm92ZXJmbG93aW5nRG9jIiwiZXF1YWxzIiwicmVtb3ZlZCIsIl9hZGRCdWZmZXJlZCIsIl9yZW1vdmVQdWJsaXNoZWQiLCJlbXB0eSIsIm5ld0RvY0lkIiwibWluRWxlbWVudElkIiwiX3JlbW92ZUJ1ZmZlcmVkIiwiX2NoYW5nZVB1Ymxpc2hlZCIsIm9sZERvYyIsInByb2plY3RlZE5ldyIsInByb2plY3RlZE9sZCIsImNoYW5nZWQiLCJEaWZmU2VxdWVuY2UiLCJtYWtlQ2hhbmdlZEZpZWxkcyIsIm1heEJ1ZmZlcmVkSWQiLCJfYWRkTWF0Y2hpbmciLCJtYXhQdWJsaXNoZWQiLCJtYXhCdWZmZXJlZCIsInRvUHVibGlzaCIsImNhbkFwcGVuZFRvQnVmZmVyIiwiY2FuSW5zZXJ0SW50b0J1ZmZlciIsInRvQnVmZmVyIiwiX3JlbW92ZU1hdGNoaW5nIiwiX2hhbmRsZURvYyIsIm1hdGNoZXNOb3ciLCJkb2N1bWVudE1hdGNoZXMiLCJwdWJsaXNoZWRCZWZvcmUiLCJidWZmZXJlZEJlZm9yZSIsImNhY2hlZEJlZm9yZSIsIm1pbkJ1ZmZlcmVkIiwic3RheXNJblB1Ymxpc2hlZCIsInN0YXlzSW5CdWZmZXIiLCJfZmV0Y2hNb2RpZmllZERvY3VtZW50cyIsInRoaXNHZW5lcmF0aW9uIiwid2FpdGluZyIsImZ1dCIsIl9iZVN0ZWFkeSIsIndyaXRlcyIsImlzUmVwbGFjZSIsImNhbkRpcmVjdGx5TW9kaWZ5RG9jIiwibW9kaWZpZXJDYW5CZURpcmVjdGx5QXBwbGllZCIsIl9tb2RpZnkiLCJjYW5CZWNvbWVUcnVlQnlNb2RpZmllciIsImFmZmVjdGVkQnlNb2RpZmllciIsIl9ydW5RdWVyeSIsImluaXRpYWwiLCJfZG9uZVF1ZXJ5aW5nIiwiX3BvbGxRdWVyeSIsIm5ld0J1ZmZlciIsIl9jdXJzb3JGb3JRdWVyeSIsImkiLCJfcHVibGlzaE5ld1Jlc3VsdHMiLCJvcHRpb25zT3ZlcndyaXRlIiwiZGVzY3JpcHRpb24iLCJpZHNUb1JlbW92ZSIsImNvbnNvbGUiLCJfb3Bsb2dFbnRyeUhhbmRsZSIsIl9saXN0ZW5lcnNIYW5kbGUiLCJwaGFzZSIsIm5vdyIsIkRhdGUiLCJ0aW1lRGlmZiIsIl9waGFzZVN0YXJ0VGltZSIsImRpc2FibGVPcGxvZyIsIl9kaXNhYmxlT3Bsb2ciLCJfY2hlY2tTdXBwb3J0ZWRQcm9qZWN0aW9uIiwiaGFzV2hlcmUiLCJoYXNHZW9RdWVyeSIsIm1vZGlmaWVyIiwib3BlcmF0aW9uIiwiZmllbGQiLCJMb2NhbENvbGxlY3Rpb25Ecml2ZXIiLCJub0Nvbm5Db2xsZWN0aW9ucyIsImNyZWF0ZSIsIm9wZW4iLCJjb25uIiwiZW5zdXJlQ29sbGVjdGlvbiIsIl9tb25nb19saXZlZGF0YV9jb2xsZWN0aW9ucyIsImNvbGxlY3Rpb25zIiwiUmVtb3RlQ29sbGVjdGlvbkRyaXZlciIsIm1vbmdvX3VybCIsIm0iLCJkZWZhdWx0UmVtb3RlQ29sbGVjdGlvbkRyaXZlciIsIm9uY2UiLCJjb25uZWN0aW9uT3B0aW9ucyIsIm1vbmdvVXJsIiwiTU9OR09fVVJMIiwiTU9OR09fT1BMT0dfVVJMIiwiX29iamVjdFNwcmVhZCIsImRlZmF1bHQiLCJjb25uZWN0aW9uIiwibWFuYWdlciIsImlkR2VuZXJhdGlvbiIsIl9kcml2ZXIiLCJfcHJldmVudEF1dG9wdWJsaXNoIiwiX21ha2VOZXdJRCIsInNyYyIsIkREUCIsInJhbmRvbVN0cmVhbSIsIlJhbmRvbSIsImluc2VjdXJlIiwiaGV4U3RyaW5nIiwiX2Nvbm5lY3Rpb24iLCJpc0NsaWVudCIsInNlcnZlciIsIl9jb2xsZWN0aW9uIiwiX25hbWUiLCJfbWF5YmVTZXRVcFJlcGxpY2F0aW9uIiwiZGVmaW5lTXV0YXRpb25NZXRob2RzIiwiX2RlZmluZU11dGF0aW9uTWV0aG9kcyIsInVzZUV4aXN0aW5nIiwiX3N1cHByZXNzU2FtZU5hbWVFcnJvciIsImF1dG9wdWJsaXNoIiwicHVibGlzaCIsImlzX2F1dG8iLCJyZWdpc3RlclN0b3JlIiwib2siLCJiZWdpblVwZGF0ZSIsImJhdGNoU2l6ZSIsInJlc2V0IiwicGF1c2VPYnNlcnZlcnMiLCJtc2ciLCJtb25nb0lkIiwiTW9uZ29JRCIsImlkUGFyc2UiLCJyZXBsYWNlIiwiJHVuc2V0IiwiJHNldCIsImVuZFVwZGF0ZSIsInJlc3VtZU9ic2VydmVycyIsInNhdmVPcmlnaW5hbHMiLCJyZXRyaWV2ZU9yaWdpbmFscyIsImdldERvYyIsIl9nZXRDb2xsZWN0aW9uIiwid2FybiIsImxvZyIsIl9nZXRGaW5kU2VsZWN0b3IiLCJfZ2V0RmluZE9wdGlvbnMiLCJNYXRjaCIsIk9wdGlvbmFsIiwiT2JqZWN0SW5jbHVkaW5nIiwiT25lT2YiLCJOdW1iZXIiLCJmYWxsYmFja0lkIiwiX3NlbGVjdG9ySXNJZCIsImdldFByb3RvdHlwZU9mIiwiZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9ycyIsImdlbmVyYXRlSWQiLCJfaXNSZW1vdGVDb2xsZWN0aW9uIiwiZW5jbG9zaW5nIiwiX0N1cnJlbnRNZXRob2RJbnZvY2F0aW9uIiwiY2hvb3NlUmV0dXJuVmFsdWVGcm9tQ29sbGVjdGlvblJlc3VsdCIsIndyYXBDYWxsYmFjayIsIl9jYWxsTXV0YXRvck1ldGhvZCIsIm9wdGlvbnNBbmRDYWxsYmFjayIsInBvcENhbGxiYWNrRnJvbUFyZ3MiLCJyYXdEYXRhYmFzZSIsImNvbnZlcnRSZXN1bHQiLCJBbGxvd0RlbnkiLCJDb2xsZWN0aW9uUHJvdG90eXBlIiwic2V0Q29ubmVjdGlvbk9wdGlvbnMiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxNQUFJQSxVQUFKO0FBQWVDLFNBQU8sQ0FBQ0MsSUFBUixDQUFhLGtCQUFiLEVBQWdDO0FBQUNGLGNBQVUsQ0FBQ0csQ0FBRCxFQUFHO0FBQUNILGdCQUFVLEdBQUNHLENBQVg7QUFBYTs7QUFBNUIsR0FBaEMsRUFBOEQsQ0FBOUQ7O0FBQWY7Ozs7Ozs7O0FBU0EsTUFBSUMsT0FBTyxHQUFHQyxnQkFBZDs7QUFDQSxNQUFJQyxNQUFNLEdBQUdDLEdBQUcsQ0FBQ0MsT0FBSixDQUFZLGVBQVosQ0FBYjs7QUFHQUMsZ0JBQWMsR0FBRyxFQUFqQjtBQUVBQSxnQkFBYyxDQUFDQyxVQUFmLEdBQTRCO0FBQzFCQyxXQUFPLEVBQUU7QUFDUEMsYUFBTyxFQUFFQyx1QkFERjtBQUVQQyxZQUFNLEVBQUVWO0FBRkQ7QUFEaUIsR0FBNUIsQyxDQU9BO0FBQ0E7QUFDQTtBQUNBOztBQUNBSyxnQkFBYyxDQUFDTSxTQUFmLEdBQTJCWCxPQUEzQixDLENBRUE7QUFDQTs7QUFDQSxNQUFJWSxZQUFZLEdBQUcsVUFBVUMsTUFBVixFQUFrQkMsS0FBbEIsRUFBeUI7QUFDMUMsUUFBSSxPQUFPQSxLQUFQLEtBQWlCLFFBQWpCLElBQTZCQSxLQUFLLEtBQUssSUFBM0MsRUFBaUQ7QUFDL0MsVUFBSUMsQ0FBQyxDQUFDQyxPQUFGLENBQVVGLEtBQVYsQ0FBSixFQUFzQjtBQUNwQixlQUFPQyxDQUFDLENBQUNFLEdBQUYsQ0FBTUgsS0FBTixFQUFhQyxDQUFDLENBQUNHLElBQUYsQ0FBT04sWUFBUCxFQUFxQixJQUFyQixFQUEyQkMsTUFBM0IsQ0FBYixDQUFQO0FBQ0Q7O0FBQ0QsVUFBSU0sR0FBRyxHQUFHLEVBQVY7O0FBQ0FKLE9BQUMsQ0FBQ0ssSUFBRixDQUFPTixLQUFQLEVBQWMsVUFBVU8sS0FBVixFQUFpQkMsR0FBakIsRUFBc0I7QUFDbENILFdBQUcsQ0FBQ04sTUFBTSxDQUFDUyxHQUFELENBQVAsQ0FBSCxHQUFtQlYsWUFBWSxDQUFDQyxNQUFELEVBQVNRLEtBQVQsQ0FBL0I7QUFDRCxPQUZEOztBQUdBLGFBQU9GLEdBQVA7QUFDRDs7QUFDRCxXQUFPTCxLQUFQO0FBQ0QsR0FaRCxDLENBY0E7QUFDQTtBQUNBOzs7QUFDQWQsU0FBTyxDQUFDdUIsU0FBUixDQUFrQkMsU0FBbEIsQ0FBNEJDLEtBQTVCLEdBQW9DLFlBQVk7QUFDOUM7QUFDQSxXQUFPLElBQVA7QUFDRCxHQUhEOztBQUtBLE1BQUlDLGNBQWMsR0FBRyxVQUFVQyxJQUFWLEVBQWdCO0FBQUUsV0FBTyxVQUFVQSxJQUFqQjtBQUF3QixHQUEvRDs7QUFDQSxNQUFJQyxnQkFBZ0IsR0FBRyxVQUFVRCxJQUFWLEVBQWdCO0FBQUUsV0FBT0EsSUFBSSxDQUFDRSxNQUFMLENBQVksQ0FBWixDQUFQO0FBQXdCLEdBQWpFOztBQUVBLE1BQUlDLDBCQUEwQixHQUFHLFVBQVVDLFFBQVYsRUFBb0I7QUFDbkQsUUFBSUEsUUFBUSxZQUFZL0IsT0FBTyxDQUFDZ0MsTUFBaEMsRUFBd0M7QUFDdEMsVUFBSUMsTUFBTSxHQUFHRixRQUFRLENBQUNWLEtBQVQsQ0FBZSxJQUFmLENBQWI7QUFDQSxhQUFPLElBQUlhLFVBQUosQ0FBZUQsTUFBZixDQUFQO0FBQ0Q7O0FBQ0QsUUFBSUYsUUFBUSxZQUFZL0IsT0FBTyxDQUFDbUMsUUFBaEMsRUFBMEM7QUFDeEMsYUFBTyxJQUFJQyxLQUFLLENBQUNELFFBQVYsQ0FBbUJKLFFBQVEsQ0FBQ00sV0FBVCxFQUFuQixDQUFQO0FBQ0Q7O0FBQ0QsUUFBSU4sUUFBUSxZQUFZL0IsT0FBTyxDQUFDc0MsVUFBaEMsRUFBNEM7QUFDMUMsYUFBT0MsT0FBTyxDQUFDUixRQUFRLENBQUNTLFFBQVQsRUFBRCxDQUFkO0FBQ0Q7O0FBQ0QsUUFBSVQsUUFBUSxDQUFDLFlBQUQsQ0FBUixJQUEwQkEsUUFBUSxDQUFDLGFBQUQsQ0FBbEMsSUFBcURoQixDQUFDLENBQUMwQixJQUFGLENBQU9WLFFBQVAsTUFBcUIsQ0FBOUUsRUFBaUY7QUFDL0UsYUFBT1csS0FBSyxDQUFDQyxhQUFOLENBQW9CL0IsWUFBWSxDQUFDZ0IsZ0JBQUQsRUFBbUJHLFFBQW5CLENBQWhDLENBQVA7QUFDRDs7QUFDRCxRQUFJQSxRQUFRLFlBQVkvQixPQUFPLENBQUN1QixTQUFoQyxFQUEyQztBQUN6QztBQUNBO0FBQ0E7QUFDQTtBQUNBLGFBQU9RLFFBQVA7QUFDRDs7QUFDRCxXQUFPYSxTQUFQO0FBQ0QsR0F0QkQ7O0FBd0JBLE1BQUlDLDBCQUEwQixHQUFHLFVBQVVkLFFBQVYsRUFBb0I7QUFDbkQsUUFBSVcsS0FBSyxDQUFDSSxRQUFOLENBQWVmLFFBQWYsQ0FBSixFQUE4QixDQUM1QjtBQUNBO0FBQ0E7QUFDQTtBQUNEOztBQUNELFFBQUlBLFFBQVEsWUFBWUssS0FBSyxDQUFDRCxRQUE5QixFQUF3QztBQUN0QyxhQUFPLElBQUluQyxPQUFPLENBQUNtQyxRQUFaLENBQXFCSixRQUFRLENBQUNNLFdBQVQsRUFBckIsQ0FBUDtBQUNEOztBQUNELFFBQUlOLFFBQVEsWUFBWS9CLE9BQU8sQ0FBQ3VCLFNBQWhDLEVBQTJDO0FBQ3pDO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsYUFBT1EsUUFBUDtBQUNEOztBQUNELFFBQUlBLFFBQVEsWUFBWVEsT0FBeEIsRUFBaUM7QUFDL0IsYUFBT3ZDLE9BQU8sQ0FBQ3NDLFVBQVIsQ0FBbUJTLFVBQW5CLENBQThCaEIsUUFBUSxDQUFDUyxRQUFULEVBQTlCLENBQVA7QUFDRDs7QUFDRCxRQUFJRSxLQUFLLENBQUNNLGFBQU4sQ0FBb0JqQixRQUFwQixDQUFKLEVBQW1DO0FBQ2pDLGFBQU9uQixZQUFZLENBQUNjLGNBQUQsRUFBaUJnQixLQUFLLENBQUNPLFdBQU4sQ0FBa0JsQixRQUFsQixDQUFqQixDQUFuQjtBQUNELEtBdEJrRCxDQXVCbkQ7QUFDQTs7O0FBQ0EsV0FBT2EsU0FBUDtBQUNELEdBMUJEOztBQTRCQSxNQUFJTSxZQUFZLEdBQUcsVUFBVW5CLFFBQVYsRUFBb0JvQixlQUFwQixFQUFxQztBQUN0RCxRQUFJLE9BQU9wQixRQUFQLEtBQW9CLFFBQXBCLElBQWdDQSxRQUFRLEtBQUssSUFBakQsRUFDRSxPQUFPQSxRQUFQO0FBRUYsUUFBSXFCLG9CQUFvQixHQUFHRCxlQUFlLENBQUNwQixRQUFELENBQTFDO0FBQ0EsUUFBSXFCLG9CQUFvQixLQUFLUixTQUE3QixFQUNFLE9BQU9RLG9CQUFQO0FBRUYsUUFBSWpDLEdBQUcsR0FBR1ksUUFBVjs7QUFDQWhCLEtBQUMsQ0FBQ0ssSUFBRixDQUFPVyxRQUFQLEVBQWlCLFVBQVVzQixHQUFWLEVBQWUvQixHQUFmLEVBQW9CO0FBQ25DLFVBQUlnQyxXQUFXLEdBQUdKLFlBQVksQ0FBQ0csR0FBRCxFQUFNRixlQUFOLENBQTlCOztBQUNBLFVBQUlFLEdBQUcsS0FBS0MsV0FBWixFQUF5QjtBQUN2QjtBQUNBLFlBQUluQyxHQUFHLEtBQUtZLFFBQVosRUFDRVosR0FBRyxHQUFHSixDQUFDLENBQUNVLEtBQUYsQ0FBUU0sUUFBUixDQUFOO0FBQ0ZaLFdBQUcsQ0FBQ0csR0FBRCxDQUFILEdBQVdnQyxXQUFYO0FBQ0Q7QUFDRixLQVJEOztBQVNBLFdBQU9uQyxHQUFQO0FBQ0QsR0FuQkQ7O0FBc0JBb0MsaUJBQWUsR0FBRyxVQUFVQyxHQUFWLEVBQWVDLE9BQWYsRUFBd0I7QUFDeEMsUUFBSUMsSUFBSSxHQUFHLElBQVg7QUFDQUQsV0FBTyxHQUFHQSxPQUFPLElBQUksRUFBckI7QUFDQUMsUUFBSSxDQUFDQyxvQkFBTCxHQUE0QixFQUE1QjtBQUNBRCxRQUFJLENBQUNFLGVBQUwsR0FBdUIsSUFBSUMsSUFBSixFQUF2QjtBQUVBLFFBQUlDLFlBQVksR0FBR0MsTUFBTSxDQUFDQyxNQUFQLENBQWM7QUFDL0I7QUFDQUMsbUJBQWEsRUFBRSxJQUZnQjtBQUcvQjtBQUNBO0FBQ0FDLG9CQUFjLEVBQUVDLFFBTGU7QUFNL0JDLHFCQUFlLEVBQUUsSUFOYztBQU8vQjtBQUNBQyxxQkFBZSxFQUFFO0FBUmMsS0FBZCxFQVNoQmpDLEtBQUssQ0FBQ2tDLGtCQVRVLENBQW5CLENBTndDLENBaUJ4QztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUNBLFFBQUksQ0FBRSwwQkFBMEJDLElBQTFCLENBQStCZixHQUEvQixDQUFOLEVBQTRDO0FBQzFDTSxrQkFBWSxDQUFDVSxhQUFiLEdBQTZCLEtBQTdCO0FBQ0QsS0EzQnVDLENBNkJ4QztBQUNBOzs7QUFDQSxRQUFJekQsQ0FBQyxDQUFDMEQsR0FBRixDQUFNaEIsT0FBTixFQUFlLFVBQWYsQ0FBSixFQUFnQztBQUM5QjtBQUNBO0FBQ0FLLGtCQUFZLENBQUNZLFFBQWIsR0FBd0JqQixPQUFPLENBQUNpQixRQUFoQztBQUNEOztBQUVEaEIsUUFBSSxDQUFDaUIsRUFBTCxHQUFVLElBQVYsQ0FyQ3dDLENBc0N4QztBQUNBO0FBQ0E7O0FBQ0FqQixRQUFJLENBQUNrQixRQUFMLEdBQWdCLElBQWhCO0FBQ0FsQixRQUFJLENBQUNtQixZQUFMLEdBQW9CLElBQXBCO0FBQ0FuQixRQUFJLENBQUNvQixXQUFMLEdBQW1CLElBQW5CO0FBR0EsUUFBSUMsYUFBYSxHQUFHLElBQUk3RSxNQUFKLEVBQXBCO0FBQ0FGLFdBQU8sQ0FBQ2dGLE9BQVIsQ0FDRXhCLEdBREYsRUFFRU0sWUFGRixFQUdFbUIsTUFBTSxDQUFDQyxlQUFQLENBQ0UsVUFBVUMsR0FBVixFQUFlQyxNQUFmLEVBQXVCO0FBQ3JCLFVBQUlELEdBQUosRUFBUztBQUNQLGNBQU1BLEdBQU47QUFDRDs7QUFFRCxVQUFJUixFQUFFLEdBQUdTLE1BQU0sQ0FBQ1QsRUFBUCxFQUFULENBTHFCLENBT3JCOztBQUNBLFVBQUlBLEVBQUUsQ0FBQ1UsWUFBSCxDQUFnQkMsV0FBcEIsRUFBaUM7QUFDL0I1QixZQUFJLENBQUNrQixRQUFMLEdBQWdCRCxFQUFFLENBQUNVLFlBQUgsQ0FBZ0JDLFdBQWhCLENBQTRCQyxPQUE1QztBQUNEOztBQUVEWixRQUFFLENBQUNVLFlBQUgsQ0FBZ0JHLEVBQWhCLENBQ0UsUUFERixFQUNZUCxNQUFNLENBQUNDLGVBQVAsQ0FBdUIsVUFBVU8sSUFBVixFQUFnQkMsR0FBaEIsRUFBcUI7QUFDcEQsWUFBSUQsSUFBSSxLQUFLLFNBQWIsRUFBd0I7QUFDdEIsY0FBSUMsR0FBRyxDQUFDSCxPQUFKLEtBQWdCN0IsSUFBSSxDQUFDa0IsUUFBekIsRUFBbUM7QUFDakNsQixnQkFBSSxDQUFDa0IsUUFBTCxHQUFnQmMsR0FBRyxDQUFDSCxPQUFwQjs7QUFDQTdCLGdCQUFJLENBQUNFLGVBQUwsQ0FBcUJ4QyxJQUFyQixDQUEwQixVQUFVdUUsUUFBVixFQUFvQjtBQUM1Q0Esc0JBQVE7QUFDUixxQkFBTyxJQUFQO0FBQ0QsYUFIRDtBQUlEO0FBQ0YsU0FSRCxNQVFPLElBQUlELEdBQUcsQ0FBQ0UsRUFBSixLQUFXbEMsSUFBSSxDQUFDa0IsUUFBcEIsRUFBOEI7QUFDbkM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBbEIsY0FBSSxDQUFDa0IsUUFBTCxHQUFnQixJQUFoQjtBQUNEO0FBQ0YsT0FqQlMsQ0FEWixFQVpxQixDQWdDckI7O0FBQ0FHLG1CQUFhLENBQUMsUUFBRCxDQUFiLENBQXdCO0FBQUVLLGNBQUY7QUFBVVQ7QUFBVixPQUF4QjtBQUNELEtBbkNILEVBb0NFSSxhQUFhLENBQUNjLFFBQWQsRUFwQ0YsQ0FvQzRCO0FBcEM1QixLQUhGLEVBL0N3QyxDQTBGeEM7QUFDQTs7QUFDQTlCLFVBQU0sQ0FBQ0MsTUFBUCxDQUFjTixJQUFkLEVBQW9CcUIsYUFBYSxDQUFDZSxJQUFkLEVBQXBCOztBQUVBLFFBQUlyQyxPQUFPLENBQUNzQyxRQUFSLElBQW9CLENBQUVDLE9BQU8sQ0FBQyxlQUFELENBQWpDLEVBQW9EO0FBQ2xEdEMsVUFBSSxDQUFDbUIsWUFBTCxHQUFvQixJQUFJb0IsV0FBSixDQUFnQnhDLE9BQU8sQ0FBQ3NDLFFBQXhCLEVBQWtDckMsSUFBSSxDQUFDaUIsRUFBTCxDQUFRdUIsWUFBMUMsQ0FBcEI7QUFDQXhDLFVBQUksQ0FBQ29CLFdBQUwsR0FBbUIsSUFBSWxGLFVBQUosQ0FBZThELElBQWYsQ0FBbkI7QUFDRDtBQUNGLEdBbEdEOztBQW9HQUgsaUJBQWUsQ0FBQy9CLFNBQWhCLENBQTBCMkUsS0FBMUIsR0FBa0MsWUFBVztBQUMzQyxRQUFJekMsSUFBSSxHQUFHLElBQVg7QUFFQSxRQUFJLENBQUVBLElBQUksQ0FBQ2lCLEVBQVgsRUFDRSxNQUFNeUIsS0FBSyxDQUFDLHlDQUFELENBQVgsQ0FKeUMsQ0FNM0M7O0FBQ0EsUUFBSUMsV0FBVyxHQUFHM0MsSUFBSSxDQUFDbUIsWUFBdkI7QUFDQW5CLFFBQUksQ0FBQ21CLFlBQUwsR0FBb0IsSUFBcEI7QUFDQSxRQUFJd0IsV0FBSixFQUNFQSxXQUFXLENBQUNDLElBQVosR0FWeUMsQ0FZM0M7QUFDQTtBQUNBOztBQUNBcEcsVUFBTSxDQUFDcUcsSUFBUCxDQUFZeEYsQ0FBQyxDQUFDRyxJQUFGLENBQU93QyxJQUFJLENBQUMwQixNQUFMLENBQVllLEtBQW5CLEVBQTBCekMsSUFBSSxDQUFDMEIsTUFBL0IsQ0FBWixFQUFvRCxJQUFwRCxFQUEwRFUsSUFBMUQ7QUFDRCxHQWhCRCxDLENBa0JBOzs7QUFDQXZDLGlCQUFlLENBQUMvQixTQUFoQixDQUEwQmdGLGFBQTFCLEdBQTBDLFVBQVVDLGNBQVYsRUFBMEI7QUFDbEUsUUFBSS9DLElBQUksR0FBRyxJQUFYO0FBRUEsUUFBSSxDQUFFQSxJQUFJLENBQUNpQixFQUFYLEVBQ0UsTUFBTXlCLEtBQUssQ0FBQyxpREFBRCxDQUFYO0FBRUYsUUFBSU0sTUFBTSxHQUFHLElBQUl4RyxNQUFKLEVBQWI7QUFDQXdELFFBQUksQ0FBQ2lCLEVBQUwsQ0FBUWdDLFVBQVIsQ0FBbUJGLGNBQW5CLEVBQW1DQyxNQUFNLENBQUNiLFFBQVAsRUFBbkM7QUFDQSxXQUFPYSxNQUFNLENBQUNaLElBQVAsRUFBUDtBQUNELEdBVEQ7O0FBV0F2QyxpQkFBZSxDQUFDL0IsU0FBaEIsQ0FBMEJvRix1QkFBMUIsR0FBb0QsVUFDaERILGNBRGdELEVBQ2hDSSxRQURnQyxFQUN0QkMsWUFEc0IsRUFDUjtBQUMxQyxRQUFJcEQsSUFBSSxHQUFHLElBQVg7QUFFQSxRQUFJLENBQUVBLElBQUksQ0FBQ2lCLEVBQVgsRUFDRSxNQUFNeUIsS0FBSyxDQUFDLDJEQUFELENBQVg7QUFFRixRQUFJTSxNQUFNLEdBQUcsSUFBSXhHLE1BQUosRUFBYjtBQUNBd0QsUUFBSSxDQUFDaUIsRUFBTCxDQUFRb0MsZ0JBQVIsQ0FDRU4sY0FERixFQUVFO0FBQUVPLFlBQU0sRUFBRSxJQUFWO0FBQWdCdkUsVUFBSSxFQUFFb0UsUUFBdEI7QUFBZ0NJLFNBQUcsRUFBRUg7QUFBckMsS0FGRixFQUdFSixNQUFNLENBQUNiLFFBQVAsRUFIRjtBQUlBYSxVQUFNLENBQUNaLElBQVA7QUFDRCxHQWJELEMsQ0FlQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQXZDLGlCQUFlLENBQUMvQixTQUFoQixDQUEwQjBGLGdCQUExQixHQUE2QyxZQUFZO0FBQ3ZELFFBQUlDLEtBQUssR0FBR0MsU0FBUyxDQUFDQyxrQkFBVixDQUE2QkMsR0FBN0IsRUFBWjs7QUFDQSxRQUFJSCxLQUFKLEVBQVc7QUFDVCxhQUFPQSxLQUFLLENBQUNJLFVBQU4sRUFBUDtBQUNELEtBRkQsTUFFTztBQUNMLGFBQU87QUFBQ0MsaUJBQVMsRUFBRSxZQUFZLENBQUU7QUFBMUIsT0FBUDtBQUNEO0FBQ0YsR0FQRCxDLENBU0E7QUFDQTs7O0FBQ0FqRSxpQkFBZSxDQUFDL0IsU0FBaEIsQ0FBMEJpRyxXQUExQixHQUF3QyxVQUFVOUIsUUFBVixFQUFvQjtBQUMxRCxXQUFPLEtBQUsvQixlQUFMLENBQXFCOEQsUUFBckIsQ0FBOEIvQixRQUE5QixDQUFQO0FBQ0QsR0FGRCxDLENBS0E7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUVBLE1BQUlnQyxhQUFhLEdBQUcsVUFBVUMsS0FBVixFQUFpQkMsT0FBakIsRUFBMEJsQyxRQUExQixFQUFvQztBQUN0RCxXQUFPLFVBQVVSLEdBQVYsRUFBZTJDLE1BQWYsRUFBdUI7QUFDNUIsVUFBSSxDQUFFM0MsR0FBTixFQUFXO0FBQ1Q7QUFDQSxZQUFJO0FBQ0YwQyxpQkFBTztBQUNSLFNBRkQsQ0FFRSxPQUFPRSxVQUFQLEVBQW1CO0FBQ25CLGNBQUlwQyxRQUFKLEVBQWM7QUFDWkEsb0JBQVEsQ0FBQ29DLFVBQUQsQ0FBUjtBQUNBO0FBQ0QsV0FIRCxNQUdPO0FBQ0wsa0JBQU1BLFVBQU47QUFDRDtBQUNGO0FBQ0Y7O0FBQ0RILFdBQUssQ0FBQ0osU0FBTjs7QUFDQSxVQUFJN0IsUUFBSixFQUFjO0FBQ1pBLGdCQUFRLENBQUNSLEdBQUQsRUFBTTJDLE1BQU4sQ0FBUjtBQUNELE9BRkQsTUFFTyxJQUFJM0MsR0FBSixFQUFTO0FBQ2QsY0FBTUEsR0FBTjtBQUNEO0FBQ0YsS0FwQkQ7QUFxQkQsR0F0QkQ7O0FBd0JBLE1BQUk2Qyx1QkFBdUIsR0FBRyxVQUFVckMsUUFBVixFQUFvQjtBQUNoRCxXQUFPVixNQUFNLENBQUNDLGVBQVAsQ0FBdUJTLFFBQXZCLEVBQWlDLGFBQWpDLENBQVA7QUFDRCxHQUZEOztBQUlBcEMsaUJBQWUsQ0FBQy9CLFNBQWhCLENBQTBCeUcsT0FBMUIsR0FBb0MsVUFBVUMsZUFBVixFQUEyQm5HLFFBQTNCLEVBQ1U0RCxRQURWLEVBQ29CO0FBQ3RELFFBQUlqQyxJQUFJLEdBQUcsSUFBWDs7QUFFQSxRQUFJeUUsU0FBUyxHQUFHLFVBQVVDLENBQVYsRUFBYTtBQUMzQixVQUFJekMsUUFBSixFQUNFLE9BQU9BLFFBQVEsQ0FBQ3lDLENBQUQsQ0FBZjtBQUNGLFlBQU1BLENBQU47QUFDRCxLQUpEOztBQU1BLFFBQUlGLGVBQWUsS0FBSyxtQ0FBeEIsRUFBNkQ7QUFDM0QsVUFBSUUsQ0FBQyxHQUFHLElBQUloQyxLQUFKLENBQVUsY0FBVixDQUFSO0FBQ0FnQyxPQUFDLENBQUNDLGVBQUYsR0FBb0IsSUFBcEI7QUFDQUYsZUFBUyxDQUFDQyxDQUFELENBQVQ7QUFDQTtBQUNEOztBQUVELFFBQUksRUFBRUUsZUFBZSxDQUFDQyxjQUFoQixDQUErQnhHLFFBQS9CLEtBQ0EsQ0FBQ1csS0FBSyxDQUFDTSxhQUFOLENBQW9CakIsUUFBcEIsQ0FESCxDQUFKLEVBQ3VDO0FBQ3JDb0csZUFBUyxDQUFDLElBQUkvQixLQUFKLENBQ1IsaURBRFEsQ0FBRCxDQUFUO0FBRUE7QUFDRDs7QUFFRCxRQUFJd0IsS0FBSyxHQUFHbEUsSUFBSSxDQUFDd0QsZ0JBQUwsRUFBWjs7QUFDQSxRQUFJVyxPQUFPLEdBQUcsWUFBWTtBQUN4QjVDLFlBQU0sQ0FBQzRDLE9BQVAsQ0FBZTtBQUFDbEIsa0JBQVUsRUFBRXVCLGVBQWI7QUFBOEJNLFVBQUUsRUFBRXpHLFFBQVEsQ0FBQzBHO0FBQTNDLE9BQWY7QUFDRCxLQUZEOztBQUdBOUMsWUFBUSxHQUFHcUMsdUJBQXVCLENBQUNMLGFBQWEsQ0FBQ0MsS0FBRCxFQUFRQyxPQUFSLEVBQWlCbEMsUUFBakIsQ0FBZCxDQUFsQzs7QUFDQSxRQUFJO0FBQ0YsVUFBSWdCLFVBQVUsR0FBR2pELElBQUksQ0FBQzhDLGFBQUwsQ0FBbUIwQixlQUFuQixDQUFqQjtBQUNBdkIsZ0JBQVUsQ0FBQytCLE1BQVgsQ0FBa0J4RixZQUFZLENBQUNuQixRQUFELEVBQVdjLDBCQUFYLENBQTlCLEVBQ2tCO0FBQUM4RixZQUFJLEVBQUU7QUFBUCxPQURsQixFQUNnQ2hELFFBRGhDO0FBRUQsS0FKRCxDQUlFLE9BQU9SLEdBQVAsRUFBWTtBQUNaeUMsV0FBSyxDQUFDSixTQUFOO0FBQ0EsWUFBTXJDLEdBQU47QUFDRDtBQUNGLEdBckNELEMsQ0F1Q0E7QUFDQTs7O0FBQ0E1QixpQkFBZSxDQUFDL0IsU0FBaEIsQ0FBMEJvSCxRQUExQixHQUFxQyxVQUFVbkMsY0FBVixFQUEwQm9DLFFBQTFCLEVBQW9DO0FBQ3ZFLFFBQUlDLFVBQVUsR0FBRztBQUFDbkMsZ0JBQVUsRUFBRUY7QUFBYixLQUFqQixDQUR1RSxDQUV2RTtBQUNBO0FBQ0E7QUFDQTs7QUFDQSxRQUFJc0MsV0FBVyxHQUFHVCxlQUFlLENBQUNVLHFCQUFoQixDQUFzQ0gsUUFBdEMsQ0FBbEI7O0FBQ0EsUUFBSUUsV0FBSixFQUFpQjtBQUNmaEksT0FBQyxDQUFDSyxJQUFGLENBQU8ySCxXQUFQLEVBQW9CLFVBQVVQLEVBQVYsRUFBYztBQUNoQ3ZELGNBQU0sQ0FBQzRDLE9BQVAsQ0FBZTlHLENBQUMsQ0FBQ2tJLE1BQUYsQ0FBUztBQUFDVCxZQUFFLEVBQUVBO0FBQUwsU0FBVCxFQUFtQk0sVUFBbkIsQ0FBZjtBQUNELE9BRkQ7QUFHRCxLQUpELE1BSU87QUFDTDdELFlBQU0sQ0FBQzRDLE9BQVAsQ0FBZWlCLFVBQWY7QUFDRDtBQUNGLEdBZEQ7O0FBZ0JBdkYsaUJBQWUsQ0FBQy9CLFNBQWhCLENBQTBCMEgsT0FBMUIsR0FBb0MsVUFBVWhCLGVBQVYsRUFBMkJXLFFBQTNCLEVBQ1VsRCxRQURWLEVBQ29CO0FBQ3RELFFBQUlqQyxJQUFJLEdBQUcsSUFBWDs7QUFFQSxRQUFJd0UsZUFBZSxLQUFLLG1DQUF4QixFQUE2RDtBQUMzRCxVQUFJRSxDQUFDLEdBQUcsSUFBSWhDLEtBQUosQ0FBVSxjQUFWLENBQVI7QUFDQWdDLE9BQUMsQ0FBQ0MsZUFBRixHQUFvQixJQUFwQjs7QUFDQSxVQUFJMUMsUUFBSixFQUFjO0FBQ1osZUFBT0EsUUFBUSxDQUFDeUMsQ0FBRCxDQUFmO0FBQ0QsT0FGRCxNQUVPO0FBQ0wsY0FBTUEsQ0FBTjtBQUNEO0FBQ0Y7O0FBRUQsUUFBSVIsS0FBSyxHQUFHbEUsSUFBSSxDQUFDd0QsZ0JBQUwsRUFBWjs7QUFDQSxRQUFJVyxPQUFPLEdBQUcsWUFBWTtBQUN4Qm5FLFVBQUksQ0FBQ2tGLFFBQUwsQ0FBY1YsZUFBZCxFQUErQlcsUUFBL0I7QUFDRCxLQUZEOztBQUdBbEQsWUFBUSxHQUFHcUMsdUJBQXVCLENBQUNMLGFBQWEsQ0FBQ0MsS0FBRCxFQUFRQyxPQUFSLEVBQWlCbEMsUUFBakIsQ0FBZCxDQUFsQzs7QUFFQSxRQUFJO0FBQ0YsVUFBSWdCLFVBQVUsR0FBR2pELElBQUksQ0FBQzhDLGFBQUwsQ0FBbUIwQixlQUFuQixDQUFqQjs7QUFDQSxVQUFJaUIsZUFBZSxHQUFHLFVBQVNoRSxHQUFULEVBQWNpRSxZQUFkLEVBQTRCO0FBQ2hEekQsZ0JBQVEsQ0FBQ1IsR0FBRCxFQUFNa0UsZUFBZSxDQUFDRCxZQUFELENBQWYsQ0FBOEJFLGNBQXBDLENBQVI7QUFDRCxPQUZEOztBQUdBM0MsZ0JBQVUsQ0FBQzRDLE1BQVgsQ0FBa0JyRyxZQUFZLENBQUMyRixRQUFELEVBQVdoRywwQkFBWCxDQUE5QixFQUNtQjtBQUFDOEYsWUFBSSxFQUFFO0FBQVAsT0FEbkIsRUFDaUNRLGVBRGpDO0FBRUQsS0FQRCxDQU9FLE9BQU9oRSxHQUFQLEVBQVk7QUFDWnlDLFdBQUssQ0FBQ0osU0FBTjtBQUNBLFlBQU1yQyxHQUFOO0FBQ0Q7QUFDRixHQS9CRDs7QUFpQ0E1QixpQkFBZSxDQUFDL0IsU0FBaEIsQ0FBMEJnSSxlQUExQixHQUE0QyxVQUFVL0MsY0FBVixFQUEwQmdELEVBQTFCLEVBQThCO0FBQ3hFLFFBQUkvRixJQUFJLEdBQUcsSUFBWDs7QUFFQSxRQUFJa0UsS0FBSyxHQUFHbEUsSUFBSSxDQUFDd0QsZ0JBQUwsRUFBWjs7QUFDQSxRQUFJVyxPQUFPLEdBQUcsWUFBWTtBQUN4QjVDLFlBQU0sQ0FBQzRDLE9BQVAsQ0FBZTtBQUFDbEIsa0JBQVUsRUFBRUYsY0FBYjtBQUE2QitCLFVBQUUsRUFBRSxJQUFqQztBQUNDa0Isc0JBQWMsRUFBRTtBQURqQixPQUFmO0FBRUQsS0FIRDs7QUFJQUQsTUFBRSxHQUFHekIsdUJBQXVCLENBQUNMLGFBQWEsQ0FBQ0MsS0FBRCxFQUFRQyxPQUFSLEVBQWlCNEIsRUFBakIsQ0FBZCxDQUE1Qjs7QUFFQSxRQUFJO0FBQ0YsVUFBSTlDLFVBQVUsR0FBR2pELElBQUksQ0FBQzhDLGFBQUwsQ0FBbUJDLGNBQW5CLENBQWpCO0FBQ0FFLGdCQUFVLENBQUNnRCxJQUFYLENBQWdCRixFQUFoQjtBQUNELEtBSEQsQ0FHRSxPQUFPckIsQ0FBUCxFQUFVO0FBQ1ZSLFdBQUssQ0FBQ0osU0FBTjtBQUNBLFlBQU1ZLENBQU47QUFDRDtBQUNGLEdBakJELEMsQ0FtQkE7QUFDQTs7O0FBQ0E3RSxpQkFBZSxDQUFDL0IsU0FBaEIsQ0FBMEJvSSxhQUExQixHQUEwQyxVQUFVSCxFQUFWLEVBQWM7QUFDdEQsUUFBSS9GLElBQUksR0FBRyxJQUFYOztBQUVBLFFBQUlrRSxLQUFLLEdBQUdsRSxJQUFJLENBQUN3RCxnQkFBTCxFQUFaOztBQUNBLFFBQUlXLE9BQU8sR0FBRyxZQUFZO0FBQ3hCNUMsWUFBTSxDQUFDNEMsT0FBUCxDQUFlO0FBQUVnQyxvQkFBWSxFQUFFO0FBQWhCLE9BQWY7QUFDRCxLQUZEOztBQUdBSixNQUFFLEdBQUd6Qix1QkFBdUIsQ0FBQ0wsYUFBYSxDQUFDQyxLQUFELEVBQVFDLE9BQVIsRUFBaUI0QixFQUFqQixDQUFkLENBQTVCOztBQUVBLFFBQUk7QUFDRi9GLFVBQUksQ0FBQ2lCLEVBQUwsQ0FBUWtGLFlBQVIsQ0FBcUJKLEVBQXJCO0FBQ0QsS0FGRCxDQUVFLE9BQU9yQixDQUFQLEVBQVU7QUFDVlIsV0FBSyxDQUFDSixTQUFOO0FBQ0EsWUFBTVksQ0FBTjtBQUNEO0FBQ0YsR0FmRDs7QUFpQkE3RSxpQkFBZSxDQUFDL0IsU0FBaEIsQ0FBMEJzSSxPQUExQixHQUFvQyxVQUFVNUIsZUFBVixFQUEyQlcsUUFBM0IsRUFBcUNrQixHQUFyQyxFQUNVdEcsT0FEVixFQUNtQmtDLFFBRG5CLEVBQzZCO0FBQy9ELFFBQUlqQyxJQUFJLEdBQUcsSUFBWDs7QUFFQSxRQUFJLENBQUVpQyxRQUFGLElBQWNsQyxPQUFPLFlBQVl1RyxRQUFyQyxFQUErQztBQUM3Q3JFLGNBQVEsR0FBR2xDLE9BQVg7QUFDQUEsYUFBTyxHQUFHLElBQVY7QUFDRDs7QUFFRCxRQUFJeUUsZUFBZSxLQUFLLG1DQUF4QixFQUE2RDtBQUMzRCxVQUFJRSxDQUFDLEdBQUcsSUFBSWhDLEtBQUosQ0FBVSxjQUFWLENBQVI7QUFDQWdDLE9BQUMsQ0FBQ0MsZUFBRixHQUFvQixJQUFwQjs7QUFDQSxVQUFJMUMsUUFBSixFQUFjO0FBQ1osZUFBT0EsUUFBUSxDQUFDeUMsQ0FBRCxDQUFmO0FBQ0QsT0FGRCxNQUVPO0FBQ0wsY0FBTUEsQ0FBTjtBQUNEO0FBQ0YsS0FoQjhELENBa0IvRDtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQSxRQUFJLENBQUMyQixHQUFELElBQVEsT0FBT0EsR0FBUCxLQUFlLFFBQTNCLEVBQ0UsTUFBTSxJQUFJM0QsS0FBSixDQUFVLCtDQUFWLENBQU47O0FBRUYsUUFBSSxFQUFFa0MsZUFBZSxDQUFDQyxjQUFoQixDQUErQndCLEdBQS9CLEtBQ0EsQ0FBQ3JILEtBQUssQ0FBQ00sYUFBTixDQUFvQitHLEdBQXBCLENBREgsQ0FBSixFQUNrQztBQUNoQyxZQUFNLElBQUkzRCxLQUFKLENBQ0osa0RBQ0UsdUJBRkUsQ0FBTjtBQUdEOztBQUVELFFBQUksQ0FBQzNDLE9BQUwsRUFBY0EsT0FBTyxHQUFHLEVBQVY7O0FBRWQsUUFBSW1FLEtBQUssR0FBR2xFLElBQUksQ0FBQ3dELGdCQUFMLEVBQVo7O0FBQ0EsUUFBSVcsT0FBTyxHQUFHLFlBQVk7QUFDeEJuRSxVQUFJLENBQUNrRixRQUFMLENBQWNWLGVBQWQsRUFBK0JXLFFBQS9CO0FBQ0QsS0FGRDs7QUFHQWxELFlBQVEsR0FBR2dDLGFBQWEsQ0FBQ0MsS0FBRCxFQUFRQyxPQUFSLEVBQWlCbEMsUUFBakIsQ0FBeEI7O0FBQ0EsUUFBSTtBQUNGLFVBQUlnQixVQUFVLEdBQUdqRCxJQUFJLENBQUM4QyxhQUFMLENBQW1CMEIsZUFBbkIsQ0FBakI7QUFDQSxVQUFJK0IsU0FBUyxHQUFHO0FBQUN0QixZQUFJLEVBQUU7QUFBUCxPQUFoQixDQUZFLENBR0Y7O0FBQ0EsVUFBSWxGLE9BQU8sQ0FBQ3lHLE1BQVosRUFBb0JELFNBQVMsQ0FBQ0MsTUFBVixHQUFtQixJQUFuQjtBQUNwQixVQUFJekcsT0FBTyxDQUFDMEcsS0FBWixFQUFtQkYsU0FBUyxDQUFDRSxLQUFWLEdBQWtCLElBQWxCLENBTGpCLENBTUY7QUFDQTtBQUNBOztBQUNBLFVBQUkxRyxPQUFPLENBQUMyRyxVQUFaLEVBQXdCSCxTQUFTLENBQUNHLFVBQVYsR0FBdUIsSUFBdkI7QUFFeEIsVUFBSUMsYUFBYSxHQUFHbkgsWUFBWSxDQUFDMkYsUUFBRCxFQUFXaEcsMEJBQVgsQ0FBaEM7QUFDQSxVQUFJeUgsUUFBUSxHQUFHcEgsWUFBWSxDQUFDNkcsR0FBRCxFQUFNbEgsMEJBQU4sQ0FBM0I7O0FBRUEsVUFBSTBILFFBQVEsR0FBR2pDLGVBQWUsQ0FBQ2tDLGtCQUFoQixDQUFtQ0YsUUFBbkMsQ0FBZjs7QUFFQSxVQUFJN0csT0FBTyxDQUFDZ0gsY0FBUixJQUEwQixDQUFDRixRQUEvQixFQUF5QztBQUN2QyxZQUFJcEYsR0FBRyxHQUFHLElBQUlpQixLQUFKLENBQVUsK0NBQVYsQ0FBVjs7QUFDQSxZQUFJVCxRQUFKLEVBQWM7QUFDWixpQkFBT0EsUUFBUSxDQUFDUixHQUFELENBQWY7QUFDRCxTQUZELE1BRU87QUFDTCxnQkFBTUEsR0FBTjtBQUNEO0FBQ0YsT0F2QkMsQ0F5QkY7QUFDQTtBQUNBO0FBQ0E7QUFFQTtBQUNBOzs7QUFDQSxVQUFJdUYsT0FBSjs7QUFDQSxVQUFJakgsT0FBTyxDQUFDeUcsTUFBWixFQUFvQjtBQUNsQixZQUFJO0FBQ0YsY0FBSVMsTUFBTSxHQUFHckMsZUFBZSxDQUFDc0MscUJBQWhCLENBQXNDL0IsUUFBdEMsRUFBZ0RrQixHQUFoRCxDQUFiOztBQUNBVyxpQkFBTyxHQUFHQyxNQUFNLENBQUNsQyxHQUFqQjtBQUNELFNBSEQsQ0FHRSxPQUFPdEQsR0FBUCxFQUFZO0FBQ1osY0FBSVEsUUFBSixFQUFjO0FBQ1osbUJBQU9BLFFBQVEsQ0FBQ1IsR0FBRCxDQUFmO0FBQ0QsV0FGRCxNQUVPO0FBQ0wsa0JBQU1BLEdBQU47QUFDRDtBQUNGO0FBQ0Y7O0FBRUQsVUFBSTFCLE9BQU8sQ0FBQ3lHLE1BQVIsSUFDQSxDQUFFSyxRQURGLElBRUEsQ0FBRUcsT0FGRixJQUdBakgsT0FBTyxDQUFDb0gsVUFIUixJQUlBLEVBQUdwSCxPQUFPLENBQUNvSCxVQUFSLFlBQThCekksS0FBSyxDQUFDRCxRQUFwQyxJQUNBc0IsT0FBTyxDQUFDcUgsV0FEWCxDQUpKLEVBSzZCO0FBQzNCO0FBQ0E7QUFDQTtBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFFQUMsb0NBQTRCLENBQzFCcEUsVUFEMEIsRUFDZDBELGFBRGMsRUFDQ0MsUUFERCxFQUNXN0csT0FEWCxFQUUxQjtBQUNBO0FBQ0E7QUFDQSxrQkFBVXVILEtBQVYsRUFBaUJsRCxNQUFqQixFQUF5QjtBQUN2QjtBQUNBO0FBQ0E7QUFDQSxjQUFJQSxNQUFNLElBQUksQ0FBRXJFLE9BQU8sQ0FBQ3dILGFBQXhCLEVBQXVDO0FBQ3JDdEYsb0JBQVEsQ0FBQ3FGLEtBQUQsRUFBUWxELE1BQU0sQ0FBQ3dCLGNBQWYsQ0FBUjtBQUNELFdBRkQsTUFFTztBQUNMM0Qsb0JBQVEsQ0FBQ3FGLEtBQUQsRUFBUWxELE1BQVIsQ0FBUjtBQUNEO0FBQ0YsU0FkeUIsQ0FBNUI7QUFnQkQsT0FoQ0QsTUFnQ087QUFFTCxZQUFJckUsT0FBTyxDQUFDeUcsTUFBUixJQUFrQixDQUFDUSxPQUFuQixJQUE4QmpILE9BQU8sQ0FBQ29ILFVBQXRDLElBQW9ETixRQUF4RCxFQUFrRTtBQUNoRSxjQUFJLENBQUNELFFBQVEsQ0FBQ1ksY0FBVCxDQUF3QixjQUF4QixDQUFMLEVBQThDO0FBQzVDWixvQkFBUSxDQUFDYSxZQUFULEdBQXdCLEVBQXhCO0FBQ0Q7O0FBQ0RULGlCQUFPLEdBQUdqSCxPQUFPLENBQUNvSCxVQUFsQjtBQUNBOUcsZ0JBQU0sQ0FBQ0MsTUFBUCxDQUFjc0csUUFBUSxDQUFDYSxZQUF2QixFQUFxQ2pJLFlBQVksQ0FBQztBQUFDdUYsZUFBRyxFQUFFaEYsT0FBTyxDQUFDb0g7QUFBZCxXQUFELEVBQTRCaEksMEJBQTVCLENBQWpEO0FBQ0Q7O0FBRUQ4RCxrQkFBVSxDQUFDeUUsTUFBWCxDQUNFZixhQURGLEVBQ2lCQyxRQURqQixFQUMyQkwsU0FEM0IsRUFFRWpDLHVCQUF1QixDQUFDLFVBQVU3QyxHQUFWLEVBQWUyQyxNQUFmLEVBQXVCO0FBQzdDLGNBQUksQ0FBRTNDLEdBQU4sRUFBVztBQUNULGdCQUFJa0csWUFBWSxHQUFHaEMsZUFBZSxDQUFDdkIsTUFBRCxDQUFsQzs7QUFDQSxnQkFBSXVELFlBQVksSUFBSTVILE9BQU8sQ0FBQ3dILGFBQTVCLEVBQTJDO0FBQ3pDO0FBQ0E7QUFDQTtBQUNBLGtCQUFJeEgsT0FBTyxDQUFDeUcsTUFBUixJQUFrQm1CLFlBQVksQ0FBQ1IsVUFBbkMsRUFBK0M7QUFDN0Msb0JBQUlILE9BQUosRUFBYTtBQUNYVyw4QkFBWSxDQUFDUixVQUFiLEdBQTBCSCxPQUExQjtBQUNELGlCQUZELE1BRU8sSUFBSVcsWUFBWSxDQUFDUixVQUFiLFlBQW1DN0ssT0FBTyxDQUFDbUMsUUFBL0MsRUFBeUQ7QUFDOURrSiw4QkFBWSxDQUFDUixVQUFiLEdBQTBCLElBQUl6SSxLQUFLLENBQUNELFFBQVYsQ0FBbUJrSixZQUFZLENBQUNSLFVBQWIsQ0FBd0J4SSxXQUF4QixFQUFuQixDQUExQjtBQUNEO0FBQ0Y7O0FBRURzRCxzQkFBUSxDQUFDUixHQUFELEVBQU1rRyxZQUFOLENBQVI7QUFDRCxhQWJELE1BYU87QUFDTDFGLHNCQUFRLENBQUNSLEdBQUQsRUFBTWtHLFlBQVksQ0FBQy9CLGNBQW5CLENBQVI7QUFDRDtBQUNGLFdBbEJELE1Ba0JPO0FBQ0wzRCxvQkFBUSxDQUFDUixHQUFELENBQVI7QUFDRDtBQUNGLFNBdEJzQixDQUZ6QjtBQXlCRDtBQUNGLEtBbEhELENBa0hFLE9BQU9pRCxDQUFQLEVBQVU7QUFDVlIsV0FBSyxDQUFDSixTQUFOO0FBQ0EsWUFBTVksQ0FBTjtBQUNEO0FBQ0YsR0EvSkQ7O0FBaUtBLE1BQUlpQixlQUFlLEdBQUcsVUFBVUQsWUFBVixFQUF3QjtBQUM1QyxRQUFJaUMsWUFBWSxHQUFHO0FBQUUvQixvQkFBYyxFQUFFO0FBQWxCLEtBQW5COztBQUNBLFFBQUlGLFlBQUosRUFBa0I7QUFDaEIsVUFBSWtDLFdBQVcsR0FBR2xDLFlBQVksQ0FBQ3RCLE1BQS9CLENBRGdCLENBR2hCO0FBQ0E7QUFDQTs7QUFDQSxVQUFJd0QsV0FBVyxDQUFDQyxRQUFoQixFQUEwQjtBQUN4QkYsb0JBQVksQ0FBQy9CLGNBQWIsSUFBK0JnQyxXQUFXLENBQUNDLFFBQVosQ0FBcUJDLE1BQXBEOztBQUVBLFlBQUlGLFdBQVcsQ0FBQ0MsUUFBWixDQUFxQkMsTUFBckIsSUFBK0IsQ0FBbkMsRUFBc0M7QUFDcENILHNCQUFZLENBQUNSLFVBQWIsR0FBMEJTLFdBQVcsQ0FBQ0MsUUFBWixDQUFxQixDQUFyQixFQUF3QjlDLEdBQWxEO0FBQ0Q7QUFDRixPQU5ELE1BTU87QUFDTDRDLG9CQUFZLENBQUMvQixjQUFiLEdBQThCZ0MsV0FBVyxDQUFDRyxDQUExQztBQUNEO0FBQ0Y7O0FBRUQsV0FBT0osWUFBUDtBQUNELEdBcEJEOztBQXVCQSxNQUFJSyxvQkFBb0IsR0FBRyxDQUEzQixDLENBRUE7O0FBQ0FuSSxpQkFBZSxDQUFDb0ksc0JBQWhCLEdBQXlDLFVBQVV4RyxHQUFWLEVBQWU7QUFFdEQ7QUFDQTtBQUNBO0FBQ0E7QUFDQSxRQUFJNkYsS0FBSyxHQUFHN0YsR0FBRyxDQUFDeUcsTUFBSixJQUFjekcsR0FBRyxDQUFDQSxHQUE5QixDQU5zRCxDQVF0RDtBQUNBO0FBQ0E7O0FBQ0EsUUFBSTZGLEtBQUssQ0FBQ2EsT0FBTixDQUFjLGlDQUFkLE1BQXFELENBQXJELElBQ0NiLEtBQUssQ0FBQ2EsT0FBTixDQUFjLG1FQUFkLE1BQXVGLENBQUMsQ0FEN0YsRUFDZ0c7QUFDOUYsYUFBTyxJQUFQO0FBQ0Q7O0FBRUQsV0FBTyxLQUFQO0FBQ0QsR0FqQkQ7O0FBbUJBLE1BQUlkLDRCQUE0QixHQUFHLFVBQVVwRSxVQUFWLEVBQXNCa0MsUUFBdEIsRUFBZ0NrQixHQUFoQyxFQUNVdEcsT0FEVixFQUNtQmtDLFFBRG5CLEVBQzZCO0FBQzlEO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUVBLFFBQUlrRixVQUFVLEdBQUdwSCxPQUFPLENBQUNvSCxVQUF6QixDQWQ4RCxDQWN6Qjs7QUFDckMsUUFBSWlCLGtCQUFrQixHQUFHO0FBQ3ZCbkQsVUFBSSxFQUFFLElBRGlCO0FBRXZCd0IsV0FBSyxFQUFFMUcsT0FBTyxDQUFDMEc7QUFGUSxLQUF6QjtBQUlBLFFBQUk0QixrQkFBa0IsR0FBRztBQUN2QnBELFVBQUksRUFBRSxJQURpQjtBQUV2QnVCLFlBQU0sRUFBRTtBQUZlLEtBQXpCO0FBS0EsUUFBSThCLGlCQUFpQixHQUFHakksTUFBTSxDQUFDQyxNQUFQLENBQ3RCZCxZQUFZLENBQUM7QUFBQ3VGLFNBQUcsRUFBRW9DO0FBQU4sS0FBRCxFQUFvQmhJLDBCQUFwQixDQURVLEVBRXRCa0gsR0FGc0IsQ0FBeEI7QUFJQSxRQUFJa0MsS0FBSyxHQUFHUCxvQkFBWjs7QUFFQSxRQUFJUSxRQUFRLEdBQUcsWUFBWTtBQUN6QkQsV0FBSzs7QUFDTCxVQUFJLENBQUVBLEtBQU4sRUFBYTtBQUNYdEcsZ0JBQVEsQ0FBQyxJQUFJUyxLQUFKLENBQVUseUJBQXlCc0Ysb0JBQXpCLEdBQWdELFNBQTFELENBQUQsQ0FBUjtBQUNELE9BRkQsTUFFTztBQUNML0Usa0JBQVUsQ0FBQ3lFLE1BQVgsQ0FBa0J2QyxRQUFsQixFQUE0QmtCLEdBQTVCLEVBQWlDK0Isa0JBQWpDLEVBQ2tCOUQsdUJBQXVCLENBQUMsVUFBVTdDLEdBQVYsRUFBZTJDLE1BQWYsRUFBdUI7QUFDN0MsY0FBSTNDLEdBQUosRUFBUztBQUNQUSxvQkFBUSxDQUFDUixHQUFELENBQVI7QUFDRCxXQUZELE1BRU8sSUFBSTJDLE1BQU0sSUFBSUEsTUFBTSxDQUFDQSxNQUFQLENBQWMyRCxDQUFkLElBQW1CLENBQWpDLEVBQW9DO0FBQ3pDOUYsb0JBQVEsQ0FBQyxJQUFELEVBQU87QUFDYjJELDRCQUFjLEVBQUV4QixNQUFNLENBQUNBLE1BQVAsQ0FBYzJEO0FBRGpCLGFBQVAsQ0FBUjtBQUdELFdBSk0sTUFJQTtBQUNMVSwrQkFBbUI7QUFDcEI7QUFDRixTQVZzQixDQUR6QztBQVlEO0FBQ0YsS0FsQkQ7O0FBb0JBLFFBQUlBLG1CQUFtQixHQUFHLFlBQVk7QUFDcEN4RixnQkFBVSxDQUFDeUUsTUFBWCxDQUFrQnZDLFFBQWxCLEVBQTRCbUQsaUJBQTVCLEVBQStDRCxrQkFBL0MsRUFDa0IvRCx1QkFBdUIsQ0FBQyxVQUFVN0MsR0FBVixFQUFlMkMsTUFBZixFQUF1QjtBQUM3QyxZQUFJM0MsR0FBSixFQUFTO0FBQ1A7QUFDQTtBQUNBO0FBQ0EsY0FBSTVCLGVBQWUsQ0FBQ29JLHNCQUFoQixDQUF1Q3hHLEdBQXZDLENBQUosRUFBaUQ7QUFDL0MrRyxvQkFBUTtBQUNULFdBRkQsTUFFTztBQUNMdkcsb0JBQVEsQ0FBQ1IsR0FBRCxDQUFSO0FBQ0Q7QUFDRixTQVRELE1BU087QUFDTFEsa0JBQVEsQ0FBQyxJQUFELEVBQU87QUFDYjJELDBCQUFjLEVBQUV4QixNQUFNLENBQUNBLE1BQVAsQ0FBY3lELFFBQWQsQ0FBdUJDLE1BRDFCO0FBRWJYLHNCQUFVLEVBQUVBO0FBRkMsV0FBUCxDQUFSO0FBSUQ7QUFDRixPQWhCc0IsQ0FEekM7QUFrQkQsS0FuQkQ7O0FBcUJBcUIsWUFBUTtBQUNULEdBekVEOztBQTJFQW5MLEdBQUMsQ0FBQ0ssSUFBRixDQUFPLENBQUMsUUFBRCxFQUFXLFFBQVgsRUFBcUIsUUFBckIsRUFBK0IsZ0JBQS9CLEVBQWlELGNBQWpELENBQVAsRUFBeUUsVUFBVWdMLE1BQVYsRUFBa0I7QUFDekY3SSxtQkFBZSxDQUFDL0IsU0FBaEIsQ0FBMEI0SyxNQUExQixJQUFvQztBQUFVO0FBQWlCO0FBQzdELFVBQUkxSSxJQUFJLEdBQUcsSUFBWDtBQUNBLGFBQU91QixNQUFNLENBQUNvSCxTQUFQLENBQWlCM0ksSUFBSSxDQUFDLE1BQU0wSSxNQUFQLENBQXJCLEVBQXFDRSxLQUFyQyxDQUEyQzVJLElBQTNDLEVBQWlENkksU0FBakQsQ0FBUDtBQUNELEtBSEQ7QUFJRCxHQUxELEUsQ0FPQTtBQUNBO0FBQ0E7OztBQUNBaEosaUJBQWUsQ0FBQy9CLFNBQWhCLENBQTBCMEksTUFBMUIsR0FBbUMsVUFBVXpELGNBQVYsRUFBMEJvQyxRQUExQixFQUFvQ2tCLEdBQXBDLEVBQ1V0RyxPQURWLEVBQ21Ca0MsUUFEbkIsRUFDNkI7QUFDOUQsUUFBSWpDLElBQUksR0FBRyxJQUFYOztBQUNBLFFBQUksT0FBT0QsT0FBUCxLQUFtQixVQUFuQixJQUFpQyxDQUFFa0MsUUFBdkMsRUFBaUQ7QUFDL0NBLGNBQVEsR0FBR2xDLE9BQVg7QUFDQUEsYUFBTyxHQUFHLEVBQVY7QUFDRDs7QUFFRCxXQUFPQyxJQUFJLENBQUMwSCxNQUFMLENBQVkzRSxjQUFaLEVBQTRCb0MsUUFBNUIsRUFBc0NrQixHQUF0QyxFQUNZaEosQ0FBQyxDQUFDa0ksTUFBRixDQUFTLEVBQVQsRUFBYXhGLE9BQWIsRUFBc0I7QUFDcEJ5RyxZQUFNLEVBQUUsSUFEWTtBQUVwQmUsbUJBQWEsRUFBRTtBQUZLLEtBQXRCLENBRFosRUFJZ0J0RixRQUpoQixDQUFQO0FBS0QsR0FiRDs7QUFlQXBDLGlCQUFlLENBQUMvQixTQUFoQixDQUEwQmdMLElBQTFCLEdBQWlDLFVBQVUvRixjQUFWLEVBQTBCb0MsUUFBMUIsRUFBb0NwRixPQUFwQyxFQUE2QztBQUM1RSxRQUFJQyxJQUFJLEdBQUcsSUFBWDtBQUVBLFFBQUk2SSxTQUFTLENBQUNmLE1BQVYsS0FBcUIsQ0FBekIsRUFDRTNDLFFBQVEsR0FBRyxFQUFYO0FBRUYsV0FBTyxJQUFJNEQsTUFBSixDQUNML0ksSUFESyxFQUNDLElBQUlnSixpQkFBSixDQUFzQmpHLGNBQXRCLEVBQXNDb0MsUUFBdEMsRUFBZ0RwRixPQUFoRCxDQURELENBQVA7QUFFRCxHQVJEOztBQVVBRixpQkFBZSxDQUFDL0IsU0FBaEIsQ0FBMEJtTCxPQUExQixHQUFvQyxVQUFVekUsZUFBVixFQUEyQlcsUUFBM0IsRUFDVXBGLE9BRFYsRUFDbUI7QUFDckQsUUFBSUMsSUFBSSxHQUFHLElBQVg7QUFDQSxRQUFJNkksU0FBUyxDQUFDZixNQUFWLEtBQXFCLENBQXpCLEVBQ0UzQyxRQUFRLEdBQUcsRUFBWDtBQUVGcEYsV0FBTyxHQUFHQSxPQUFPLElBQUksRUFBckI7QUFDQUEsV0FBTyxDQUFDbUosS0FBUixHQUFnQixDQUFoQjtBQUNBLFdBQU9sSixJQUFJLENBQUM4SSxJQUFMLENBQVV0RSxlQUFWLEVBQTJCVyxRQUEzQixFQUFxQ3BGLE9BQXJDLEVBQThDb0osS0FBOUMsR0FBc0QsQ0FBdEQsQ0FBUDtBQUNELEdBVEQsQyxDQVdBO0FBQ0E7OztBQUNBdEosaUJBQWUsQ0FBQy9CLFNBQWhCLENBQTBCc0wsWUFBMUIsR0FBeUMsVUFBVXJHLGNBQVYsRUFBMEJzRyxLQUExQixFQUNVdEosT0FEVixFQUNtQjtBQUMxRCxRQUFJO0FBQ0YsVUFBSUMsSUFBSSxHQUFHLElBQVgsQ0FERSxDQUVGO0FBQ0E7O0FBQ0EsVUFBSWlELFVBQVUsR0FBR2pELElBQUksQ0FBQzhDLGFBQUwsQ0FBbUJDLGNBQW5CLENBQWpCO0FBQ0EsVUFBSUMsTUFBTSxHQUFHLElBQUl4RyxNQUFKLEVBQWI7QUFDQSxVQUFJOE0sU0FBUyxHQUFHckcsVUFBVSxDQUFDc0csV0FBWCxDQUF1QkYsS0FBdkIsRUFBOEJ0SixPQUE5QixFQUF1Q2lELE1BQU0sQ0FBQ2IsUUFBUCxFQUF2QyxDQUFoQjtBQUNBYSxZQUFNLENBQUNaLElBQVA7QUFDRCxLQVJELENBUUUsT0FBT29ILFNBQVAsRUFBa0IsQ0FFbkI7QUFDRixHQWJEOztBQWNBM0osaUJBQWUsQ0FBQy9CLFNBQWhCLENBQTBCMkwsVUFBMUIsR0FBdUMsVUFBVTFHLGNBQVYsRUFBMEJzRyxLQUExQixFQUFpQztBQUN0RSxRQUFJckosSUFBSSxHQUFHLElBQVgsQ0FEc0UsQ0FHdEU7QUFDQTs7QUFDQSxRQUFJaUQsVUFBVSxHQUFHakQsSUFBSSxDQUFDOEMsYUFBTCxDQUFtQkMsY0FBbkIsQ0FBakI7QUFDQSxRQUFJQyxNQUFNLEdBQUcsSUFBSXhHLE1BQUosRUFBYjtBQUNBLFFBQUk4TSxTQUFTLEdBQUdyRyxVQUFVLENBQUN5RyxTQUFYLENBQXFCTCxLQUFyQixFQUE0QnJHLE1BQU0sQ0FBQ2IsUUFBUCxFQUE1QixDQUFoQjtBQUNBYSxVQUFNLENBQUNaLElBQVA7QUFDRCxHQVRELEMsQ0FXQTtBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FBRUE0RyxtQkFBaUIsR0FBRyxVQUFVakcsY0FBVixFQUEwQm9DLFFBQTFCLEVBQW9DcEYsT0FBcEMsRUFBNkM7QUFDL0QsUUFBSUMsSUFBSSxHQUFHLElBQVg7QUFDQUEsUUFBSSxDQUFDK0MsY0FBTCxHQUFzQkEsY0FBdEI7QUFDQS9DLFFBQUksQ0FBQ21GLFFBQUwsR0FBZ0J6RyxLQUFLLENBQUNpTCxVQUFOLENBQWlCQyxnQkFBakIsQ0FBa0N6RSxRQUFsQyxDQUFoQjtBQUNBbkYsUUFBSSxDQUFDRCxPQUFMLEdBQWVBLE9BQU8sSUFBSSxFQUExQjtBQUNELEdBTEQ7O0FBT0FnSixRQUFNLEdBQUcsVUFBVWMsS0FBVixFQUFpQkMsaUJBQWpCLEVBQW9DO0FBQzNDLFFBQUk5SixJQUFJLEdBQUcsSUFBWDtBQUVBQSxRQUFJLENBQUMrSixNQUFMLEdBQWNGLEtBQWQ7QUFDQTdKLFFBQUksQ0FBQ2dLLGtCQUFMLEdBQTBCRixpQkFBMUI7QUFDQTlKLFFBQUksQ0FBQ2lLLGtCQUFMLEdBQTBCLElBQTFCO0FBQ0QsR0FORDs7QUFRQTVNLEdBQUMsQ0FBQ0ssSUFBRixDQUFPLENBQUMsU0FBRCxFQUFZLEtBQVosRUFBbUIsT0FBbkIsRUFBNEIsT0FBNUIsRUFBcUN3TSxNQUFNLENBQUNDLFFBQTVDLENBQVAsRUFBOEQsVUFBVXpCLE1BQVYsRUFBa0I7QUFDOUVLLFVBQU0sQ0FBQ2pMLFNBQVAsQ0FBaUI0SyxNQUFqQixJQUEyQixZQUFZO0FBQ3JDLFVBQUkxSSxJQUFJLEdBQUcsSUFBWCxDQURxQyxDQUdyQzs7QUFDQSxVQUFJQSxJQUFJLENBQUNnSyxrQkFBTCxDQUF3QmpLLE9BQXhCLENBQWdDcUssUUFBcEMsRUFDRSxNQUFNLElBQUkxSCxLQUFKLENBQVUsaUJBQWlCZ0csTUFBakIsR0FBMEIsdUJBQXBDLENBQU47O0FBRUYsVUFBSSxDQUFDMUksSUFBSSxDQUFDaUssa0JBQVYsRUFBOEI7QUFDNUJqSyxZQUFJLENBQUNpSyxrQkFBTCxHQUEwQmpLLElBQUksQ0FBQytKLE1BQUwsQ0FBWU0sd0JBQVosQ0FDeEJySyxJQUFJLENBQUNnSyxrQkFEbUIsRUFDQztBQUN2QjtBQUNBO0FBQ0FNLDBCQUFnQixFQUFFdEssSUFISztBQUl2QnVLLHNCQUFZLEVBQUU7QUFKUyxTQURELENBQTFCO0FBT0Q7O0FBRUQsYUFBT3ZLLElBQUksQ0FBQ2lLLGtCQUFMLENBQXdCdkIsTUFBeEIsRUFBZ0NFLEtBQWhDLENBQ0w1SSxJQUFJLENBQUNpSyxrQkFEQSxFQUNvQnBCLFNBRHBCLENBQVA7QUFFRCxLQW5CRDtBQW9CRCxHQXJCRCxFLENBdUJBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQUUsUUFBTSxDQUFDakwsU0FBUCxDQUFpQjBNLE1BQWpCLEdBQTBCLFlBQVksQ0FDckMsQ0FERDs7QUFHQXpCLFFBQU0sQ0FBQ2pMLFNBQVAsQ0FBaUIyTSxZQUFqQixHQUFnQyxZQUFZO0FBQzFDLFdBQU8sS0FBS1Qsa0JBQUwsQ0FBd0JqSyxPQUF4QixDQUFnQzJLLFNBQXZDO0FBQ0QsR0FGRCxDLENBSUE7QUFDQTtBQUNBOzs7QUFFQTNCLFFBQU0sQ0FBQ2pMLFNBQVAsQ0FBaUI2TSxjQUFqQixHQUFrQyxVQUFVQyxHQUFWLEVBQWU7QUFDL0MsUUFBSTVLLElBQUksR0FBRyxJQUFYO0FBQ0EsUUFBSWlELFVBQVUsR0FBR2pELElBQUksQ0FBQ2dLLGtCQUFMLENBQXdCakgsY0FBekM7QUFDQSxXQUFPckUsS0FBSyxDQUFDaUwsVUFBTixDQUFpQmdCLGNBQWpCLENBQWdDM0ssSUFBaEMsRUFBc0M0SyxHQUF0QyxFQUEyQzNILFVBQTNDLENBQVA7QUFDRCxHQUpELEMsQ0FNQTtBQUNBO0FBQ0E7OztBQUNBOEYsUUFBTSxDQUFDakwsU0FBUCxDQUFpQitNLGtCQUFqQixHQUFzQyxZQUFZO0FBQ2hELFFBQUk3SyxJQUFJLEdBQUcsSUFBWDtBQUNBLFdBQU9BLElBQUksQ0FBQ2dLLGtCQUFMLENBQXdCakgsY0FBL0I7QUFDRCxHQUhEOztBQUtBZ0csUUFBTSxDQUFDakwsU0FBUCxDQUFpQmdOLE9BQWpCLEdBQTJCLFVBQVVDLFNBQVYsRUFBcUI7QUFDOUMsUUFBSS9LLElBQUksR0FBRyxJQUFYO0FBQ0EsV0FBTzRFLGVBQWUsQ0FBQ29HLDBCQUFoQixDQUEyQ2hMLElBQTNDLEVBQWlEK0ssU0FBakQsQ0FBUDtBQUNELEdBSEQ7O0FBS0FoQyxRQUFNLENBQUNqTCxTQUFQLENBQWlCbU4sY0FBakIsR0FBa0MsVUFBVUYsU0FBVixFQUFxQjtBQUNyRCxRQUFJL0ssSUFBSSxHQUFHLElBQVg7QUFDQSxRQUFJa0wsT0FBTyxHQUFHLENBQ1osU0FEWSxFQUVaLE9BRlksRUFHWixXQUhZLEVBSVosU0FKWSxFQUtaLFdBTFksRUFNWixTQU5ZLEVBT1osU0FQWSxDQUFkOztBQVNBLFFBQUlDLE9BQU8sR0FBR3ZHLGVBQWUsQ0FBQ3dHLGtDQUFoQixDQUFtREwsU0FBbkQsQ0FBZCxDQVhxRCxDQWFyRDs7O0FBQ0EsUUFBSU0sYUFBYSxHQUFHLGtDQUFwQjtBQUNBSCxXQUFPLENBQUNJLE9BQVIsQ0FBZ0IsVUFBVTVDLE1BQVYsRUFBa0I7QUFDaEMsVUFBSXFDLFNBQVMsQ0FBQ3JDLE1BQUQsQ0FBVCxJQUFxQixPQUFPcUMsU0FBUyxDQUFDckMsTUFBRCxDQUFoQixJQUE0QixVQUFyRCxFQUFpRTtBQUMvRHFDLGlCQUFTLENBQUNyQyxNQUFELENBQVQsR0FBb0JuSCxNQUFNLENBQUNDLGVBQVAsQ0FBdUJ1SixTQUFTLENBQUNyQyxNQUFELENBQWhDLEVBQTBDQSxNQUFNLEdBQUcyQyxhQUFuRCxDQUFwQjtBQUNEO0FBQ0YsS0FKRDtBQU1BLFdBQU9yTCxJQUFJLENBQUMrSixNQUFMLENBQVl3QixlQUFaLENBQ0x2TCxJQUFJLENBQUNnSyxrQkFEQSxFQUNvQm1CLE9BRHBCLEVBQzZCSixTQUQ3QixDQUFQO0FBRUQsR0F2QkQ7O0FBeUJBbEwsaUJBQWUsQ0FBQy9CLFNBQWhCLENBQTBCdU0sd0JBQTFCLEdBQXFELFVBQ2pEUCxpQkFEaUQsRUFDOUIvSixPQUQ4QixFQUNyQjtBQUM5QixRQUFJQyxJQUFJLEdBQUcsSUFBWDtBQUNBRCxXQUFPLEdBQUcxQyxDQUFDLENBQUNtTyxJQUFGLENBQU96TCxPQUFPLElBQUksRUFBbEIsRUFBc0Isa0JBQXRCLEVBQTBDLGNBQTFDLENBQVY7QUFFQSxRQUFJa0QsVUFBVSxHQUFHakQsSUFBSSxDQUFDOEMsYUFBTCxDQUFtQmdILGlCQUFpQixDQUFDL0csY0FBckMsQ0FBakI7QUFDQSxRQUFJMEksYUFBYSxHQUFHM0IsaUJBQWlCLENBQUMvSixPQUF0QztBQUNBLFFBQUlLLFlBQVksR0FBRztBQUNqQnNMLFVBQUksRUFBRUQsYUFBYSxDQUFDQyxJQURIO0FBRWpCeEMsV0FBSyxFQUFFdUMsYUFBYSxDQUFDdkMsS0FGSjtBQUdqQnlDLFVBQUksRUFBRUYsYUFBYSxDQUFDRSxJQUhIO0FBSWpCQyxnQkFBVSxFQUFFSCxhQUFhLENBQUNJO0FBSlQsS0FBbkIsQ0FOOEIsQ0FhOUI7O0FBQ0EsUUFBSUosYUFBYSxDQUFDckIsUUFBbEIsRUFBNEI7QUFDMUI7QUFDQWhLLGtCQUFZLENBQUNnSyxRQUFiLEdBQXdCLElBQXhCLENBRjBCLENBRzFCO0FBQ0E7O0FBQ0FoSyxrQkFBWSxDQUFDMEwsU0FBYixHQUF5QixJQUF6QixDQUwwQixDQU0xQjtBQUNBOztBQUNBMUwsa0JBQVksQ0FBQzJMLGVBQWIsR0FBK0IsQ0FBQyxDQUFoQyxDQVIwQixDQVMxQjtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUNBLFVBQUlqQyxpQkFBaUIsQ0FBQy9HLGNBQWxCLEtBQXFDaUosZ0JBQXJDLElBQ0FsQyxpQkFBaUIsQ0FBQzNFLFFBQWxCLENBQTJCOEcsRUFEL0IsRUFDbUM7QUFDakM3TCxvQkFBWSxDQUFDOEwsV0FBYixHQUEyQixJQUEzQjtBQUNEO0FBQ0Y7O0FBRUQsUUFBSUMsUUFBUSxHQUFHbEosVUFBVSxDQUFDNkYsSUFBWCxDQUNidEosWUFBWSxDQUFDc0ssaUJBQWlCLENBQUMzRSxRQUFuQixFQUE2QmhHLDBCQUE3QixDQURDLEVBRWJpQixZQUZhLENBQWY7O0FBSUEsUUFBSSxPQUFPcUwsYUFBYSxDQUFDVyxTQUFyQixLQUFtQyxXQUF2QyxFQUFvRDtBQUNsREQsY0FBUSxHQUFHQSxRQUFRLENBQUNFLFNBQVQsQ0FBbUJaLGFBQWEsQ0FBQ1csU0FBakMsQ0FBWDtBQUNEOztBQUNELFFBQUksT0FBT1gsYUFBYSxDQUFDYSxJQUFyQixLQUE4QixXQUFsQyxFQUErQztBQUM3Q0gsY0FBUSxHQUFHQSxRQUFRLENBQUNHLElBQVQsQ0FBY2IsYUFBYSxDQUFDYSxJQUE1QixDQUFYO0FBQ0Q7O0FBRUQsV0FBTyxJQUFJQyxpQkFBSixDQUFzQkosUUFBdEIsRUFBZ0NyQyxpQkFBaEMsRUFBbUQvSixPQUFuRCxDQUFQO0FBQ0QsR0EvQ0Q7O0FBaURBLE1BQUl3TSxpQkFBaUIsR0FBRyxVQUFVSixRQUFWLEVBQW9CckMsaUJBQXBCLEVBQXVDL0osT0FBdkMsRUFBZ0Q7QUFDdEUsUUFBSUMsSUFBSSxHQUFHLElBQVg7QUFDQUQsV0FBTyxHQUFHMUMsQ0FBQyxDQUFDbU8sSUFBRixDQUFPekwsT0FBTyxJQUFJLEVBQWxCLEVBQXNCLGtCQUF0QixFQUEwQyxjQUExQyxDQUFWO0FBRUFDLFFBQUksQ0FBQ3dNLFNBQUwsR0FBaUJMLFFBQWpCO0FBQ0FuTSxRQUFJLENBQUNnSyxrQkFBTCxHQUEwQkYsaUJBQTFCLENBTHNFLENBTXRFO0FBQ0E7O0FBQ0E5SixRQUFJLENBQUN5TSxpQkFBTCxHQUF5QjFNLE9BQU8sQ0FBQ3VLLGdCQUFSLElBQTRCdEssSUFBckQ7O0FBQ0EsUUFBSUQsT0FBTyxDQUFDd0ssWUFBUixJQUF3QlQsaUJBQWlCLENBQUMvSixPQUFsQixDQUEwQjJLLFNBQXRELEVBQWlFO0FBQy9EMUssVUFBSSxDQUFDME0sVUFBTCxHQUFrQjlILGVBQWUsQ0FBQytILGFBQWhCLENBQ2hCN0MsaUJBQWlCLENBQUMvSixPQUFsQixDQUEwQjJLLFNBRFYsQ0FBbEI7QUFFRCxLQUhELE1BR087QUFDTDFLLFVBQUksQ0FBQzBNLFVBQUwsR0FBa0IsSUFBbEI7QUFDRDs7QUFFRDFNLFFBQUksQ0FBQzRNLGlCQUFMLEdBQXlCcFEsTUFBTSxDQUFDcUcsSUFBUCxDQUFZc0osUUFBUSxDQUFDVSxLQUFULENBQWVyUCxJQUFmLENBQW9CMk8sUUFBcEIsQ0FBWixDQUF6QjtBQUNBbk0sUUFBSSxDQUFDOE0sV0FBTCxHQUFtQixJQUFJbEksZUFBZSxDQUFDbUksTUFBcEIsRUFBbkI7QUFDRCxHQWxCRDs7QUFvQkExUCxHQUFDLENBQUNrSSxNQUFGLENBQVNnSCxpQkFBaUIsQ0FBQ3pPLFNBQTNCLEVBQXNDO0FBQ3BDO0FBQ0E7QUFDQWtQLHlCQUFxQixFQUFFLFlBQVk7QUFDakMsWUFBTWhOLElBQUksR0FBRyxJQUFiO0FBQ0EsYUFBTyxJQUFJaU4sT0FBSixDQUFZLENBQUNDLE9BQUQsRUFBVUMsTUFBVixLQUFxQjtBQUN0Q25OLFlBQUksQ0FBQ3dNLFNBQUwsQ0FBZVksSUFBZixDQUFvQixDQUFDM0wsR0FBRCxFQUFNTyxHQUFOLEtBQWM7QUFDaEMsY0FBSVAsR0FBSixFQUFTO0FBQ1AwTCxrQkFBTSxDQUFDMUwsR0FBRCxDQUFOO0FBQ0QsV0FGRCxNQUVPO0FBQ0x5TCxtQkFBTyxDQUFDbEwsR0FBRCxDQUFQO0FBQ0Q7QUFDRixTQU5EO0FBT0QsT0FSTSxDQUFQO0FBU0QsS0FkbUM7QUFnQnBDO0FBQ0E7QUFDQXFMLHNCQUFrQixFQUFFO0FBQUEsc0NBQWtCO0FBQ3BDLFlBQUlyTixJQUFJLEdBQUcsSUFBWDs7QUFFQSxlQUFPLElBQVAsRUFBYTtBQUNYLGNBQUlnQyxHQUFHLGlCQUFTaEMsSUFBSSxDQUFDZ04scUJBQUwsRUFBVCxDQUFQO0FBRUEsY0FBSSxDQUFDaEwsR0FBTCxFQUFVLE9BQU8sSUFBUDtBQUNWQSxhQUFHLEdBQUd4QyxZQUFZLENBQUN3QyxHQUFELEVBQU01RCwwQkFBTixDQUFsQjs7QUFFQSxjQUFJLENBQUM0QixJQUFJLENBQUNnSyxrQkFBTCxDQUF3QmpLLE9BQXhCLENBQWdDcUssUUFBakMsSUFBNkMvTSxDQUFDLENBQUMwRCxHQUFGLENBQU1pQixHQUFOLEVBQVcsS0FBWCxDQUFqRCxFQUFvRTtBQUNsRTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxnQkFBSWhDLElBQUksQ0FBQzhNLFdBQUwsQ0FBaUIvTCxHQUFqQixDQUFxQmlCLEdBQUcsQ0FBQytDLEdBQXpCLENBQUosRUFBbUM7O0FBQ25DL0UsZ0JBQUksQ0FBQzhNLFdBQUwsQ0FBaUJRLEdBQWpCLENBQXFCdEwsR0FBRyxDQUFDK0MsR0FBekIsRUFBOEIsSUFBOUI7QUFDRDs7QUFFRCxjQUFJL0UsSUFBSSxDQUFDME0sVUFBVCxFQUNFMUssR0FBRyxHQUFHaEMsSUFBSSxDQUFDME0sVUFBTCxDQUFnQjFLLEdBQWhCLENBQU47QUFFRixpQkFBT0EsR0FBUDtBQUNEO0FBQ0YsT0F6Qm1CO0FBQUEsS0FsQmdCO0FBNkNwQztBQUNBO0FBQ0E7QUFDQXVMLGlDQUE2QixFQUFFLFVBQVVDLFNBQVYsRUFBcUI7QUFDbEQsWUFBTXhOLElBQUksR0FBRyxJQUFiOztBQUNBLFVBQUksQ0FBQ3dOLFNBQUwsRUFBZ0I7QUFDZCxlQUFPeE4sSUFBSSxDQUFDcU4sa0JBQUwsRUFBUDtBQUNEOztBQUNELFlBQU1JLGlCQUFpQixHQUFHek4sSUFBSSxDQUFDcU4sa0JBQUwsRUFBMUI7O0FBQ0EsWUFBTUssVUFBVSxHQUFHLElBQUloTCxLQUFKLENBQVUsNkNBQVYsQ0FBbkI7QUFDQSxZQUFNaUwsY0FBYyxHQUFHLElBQUlWLE9BQUosQ0FBWSxDQUFDQyxPQUFELEVBQVVDLE1BQVYsS0FBcUI7QUFDdEQsY0FBTVMsS0FBSyxHQUFHQyxVQUFVLENBQUMsTUFBTTtBQUM3QlYsZ0JBQU0sQ0FBQ08sVUFBRCxDQUFOO0FBQ0QsU0FGdUIsRUFFckJGLFNBRnFCLENBQXhCO0FBR0QsT0FKc0IsQ0FBdkI7QUFLQSxhQUFPUCxPQUFPLENBQUNhLElBQVIsQ0FBYSxDQUFDTCxpQkFBRCxFQUFvQkUsY0FBcEIsQ0FBYixFQUNKSSxLQURJLENBQ0d0TSxHQUFELElBQVM7QUFDZCxZQUFJQSxHQUFHLEtBQUtpTSxVQUFaLEVBQXdCO0FBQ3RCMU4sY0FBSSxDQUFDeUMsS0FBTDtBQUNEOztBQUNELGNBQU1oQixHQUFOO0FBQ0QsT0FOSSxDQUFQO0FBT0QsS0FuRW1DO0FBcUVwQ3VNLGVBQVcsRUFBRSxZQUFZO0FBQ3ZCLFVBQUloTyxJQUFJLEdBQUcsSUFBWDtBQUNBLGFBQU9BLElBQUksQ0FBQ3FOLGtCQUFMLEdBQTBCWSxLQUExQixFQUFQO0FBQ0QsS0F4RW1DO0FBMEVwQzNDLFdBQU8sRUFBRSxVQUFVckosUUFBVixFQUFvQmlNLE9BQXBCLEVBQTZCO0FBQ3BDLFVBQUlsTyxJQUFJLEdBQUcsSUFBWCxDQURvQyxDQUdwQzs7QUFDQUEsVUFBSSxDQUFDbU8sT0FBTCxHQUpvQyxDQU1wQztBQUNBO0FBQ0E7OztBQUNBLFVBQUk5RSxLQUFLLEdBQUcsQ0FBWjs7QUFDQSxhQUFPLElBQVAsRUFBYTtBQUNYLFlBQUlySCxHQUFHLEdBQUdoQyxJQUFJLENBQUNnTyxXQUFMLEVBQVY7O0FBQ0EsWUFBSSxDQUFDaE0sR0FBTCxFQUFVO0FBQ1ZDLGdCQUFRLENBQUNtTSxJQUFULENBQWNGLE9BQWQsRUFBdUJsTSxHQUF2QixFQUE0QnFILEtBQUssRUFBakMsRUFBcUNySixJQUFJLENBQUN5TSxpQkFBMUM7QUFDRDtBQUNGLEtBekZtQztBQTJGcEM7QUFDQWxQLE9BQUcsRUFBRSxVQUFVMEUsUUFBVixFQUFvQmlNLE9BQXBCLEVBQTZCO0FBQ2hDLFVBQUlsTyxJQUFJLEdBQUcsSUFBWDtBQUNBLFVBQUlxTyxHQUFHLEdBQUcsRUFBVjtBQUNBck8sVUFBSSxDQUFDc0wsT0FBTCxDQUFhLFVBQVV0SixHQUFWLEVBQWVxSCxLQUFmLEVBQXNCO0FBQ2pDZ0YsV0FBRyxDQUFDQyxJQUFKLENBQVNyTSxRQUFRLENBQUNtTSxJQUFULENBQWNGLE9BQWQsRUFBdUJsTSxHQUF2QixFQUE0QnFILEtBQTVCLEVBQW1DckosSUFBSSxDQUFDeU0saUJBQXhDLENBQVQ7QUFDRCxPQUZEO0FBR0EsYUFBTzRCLEdBQVA7QUFDRCxLQW5HbUM7QUFxR3BDRixXQUFPLEVBQUUsWUFBWTtBQUNuQixVQUFJbk8sSUFBSSxHQUFHLElBQVgsQ0FEbUIsQ0FHbkI7O0FBQ0FBLFVBQUksQ0FBQ3dNLFNBQUwsQ0FBZWhDLE1BQWY7O0FBRUF4SyxVQUFJLENBQUM4TSxXQUFMLEdBQW1CLElBQUlsSSxlQUFlLENBQUNtSSxNQUFwQixFQUFuQjtBQUNELEtBNUdtQztBQThHcEM7QUFDQXRLLFNBQUssRUFBRSxZQUFZO0FBQ2pCLFVBQUl6QyxJQUFJLEdBQUcsSUFBWDs7QUFFQUEsVUFBSSxDQUFDd00sU0FBTCxDQUFlL0osS0FBZjtBQUNELEtBbkhtQztBQXFIcEMwRyxTQUFLLEVBQUUsWUFBWTtBQUNqQixVQUFJbkosSUFBSSxHQUFHLElBQVg7QUFDQSxhQUFPQSxJQUFJLENBQUN6QyxHQUFMLENBQVNGLENBQUMsQ0FBQ2tSLFFBQVgsQ0FBUDtBQUNELEtBeEhtQztBQTBIcEMxQixTQUFLLEVBQUUsWUFBa0M7QUFBQSxVQUF4QjJCLGNBQXdCLHVFQUFQLEtBQU87QUFDdkMsVUFBSXhPLElBQUksR0FBRyxJQUFYO0FBQ0EsYUFBT0EsSUFBSSxDQUFDNE0saUJBQUwsQ0FBdUI0QixjQUF2QixFQUF1Q3BNLElBQXZDLEVBQVA7QUFDRCxLQTdIbUM7QUErSHBDO0FBQ0FxTSxpQkFBYSxFQUFFLFVBQVV0RCxPQUFWLEVBQW1CO0FBQ2hDLFVBQUluTCxJQUFJLEdBQUcsSUFBWDs7QUFDQSxVQUFJbUwsT0FBSixFQUFhO0FBQ1gsZUFBT25MLElBQUksQ0FBQ21KLEtBQUwsRUFBUDtBQUNELE9BRkQsTUFFTztBQUNMLFlBQUl1RixPQUFPLEdBQUcsSUFBSTlKLGVBQWUsQ0FBQ21JLE1BQXBCLEVBQWQ7QUFDQS9NLFlBQUksQ0FBQ3NMLE9BQUwsQ0FBYSxVQUFVdEosR0FBVixFQUFlO0FBQzFCME0saUJBQU8sQ0FBQ3BCLEdBQVIsQ0FBWXRMLEdBQUcsQ0FBQytDLEdBQWhCLEVBQXFCL0MsR0FBckI7QUFDRCxTQUZEO0FBR0EsZUFBTzBNLE9BQVA7QUFDRDtBQUNGO0FBM0ltQyxHQUF0Qzs7QUE4SUFuQyxtQkFBaUIsQ0FBQ3pPLFNBQWxCLENBQTRCb00sTUFBTSxDQUFDQyxRQUFuQyxJQUErQyxZQUFZO0FBQ3pELFFBQUluSyxJQUFJLEdBQUcsSUFBWCxDQUR5RCxDQUd6RDs7QUFDQUEsUUFBSSxDQUFDbU8sT0FBTDs7QUFFQSxXQUFPO0FBQ0xmLFVBQUksR0FBRztBQUNMLGNBQU1wTCxHQUFHLEdBQUdoQyxJQUFJLENBQUNnTyxXQUFMLEVBQVo7O0FBQ0EsZUFBT2hNLEdBQUcsR0FBRztBQUNYckUsZUFBSyxFQUFFcUU7QUFESSxTQUFILEdBRU47QUFDRjJNLGNBQUksRUFBRTtBQURKLFNBRko7QUFLRDs7QUFSSSxLQUFQO0FBVUQsR0FoQkQsQyxDQWtCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUNBOU8saUJBQWUsQ0FBQy9CLFNBQWhCLENBQTBCOFEsSUFBMUIsR0FBaUMsVUFBVTlFLGlCQUFWLEVBQTZCK0UsV0FBN0IsRUFBMENyQixTQUExQyxFQUFxRDtBQUNwRixRQUFJeE4sSUFBSSxHQUFHLElBQVg7QUFDQSxRQUFJLENBQUM4SixpQkFBaUIsQ0FBQy9KLE9BQWxCLENBQTBCcUssUUFBL0IsRUFDRSxNQUFNLElBQUkxSCxLQUFKLENBQVUsaUNBQVYsQ0FBTjs7QUFFRixRQUFJb00sTUFBTSxHQUFHOU8sSUFBSSxDQUFDcUssd0JBQUwsQ0FBOEJQLGlCQUE5QixDQUFiOztBQUVBLFFBQUlpRixPQUFPLEdBQUcsS0FBZDtBQUNBLFFBQUlDLE1BQUo7O0FBQ0EsUUFBSUMsSUFBSSxHQUFHLFlBQVk7QUFDckIsVUFBSWpOLEdBQUcsR0FBRyxJQUFWOztBQUNBLGFBQU8sSUFBUCxFQUFhO0FBQ1gsWUFBSStNLE9BQUosRUFDRTs7QUFDRixZQUFJO0FBQ0YvTSxhQUFHLEdBQUc4TSxNQUFNLENBQUN2Qiw2QkFBUCxDQUFxQ0MsU0FBckMsRUFBZ0RTLEtBQWhELEVBQU47QUFDRCxTQUZELENBRUUsT0FBT3hNLEdBQVAsRUFBWTtBQUNaO0FBQ0E7QUFDQTtBQUNBO0FBQ0FPLGFBQUcsR0FBRyxJQUFOO0FBQ0QsU0FYVSxDQVlYO0FBQ0E7OztBQUNBLFlBQUkrTSxPQUFKLEVBQ0U7O0FBQ0YsWUFBSS9NLEdBQUosRUFBUztBQUNQO0FBQ0E7QUFDQTtBQUNBO0FBQ0FnTixnQkFBTSxHQUFHaE4sR0FBRyxDQUFDaUssRUFBYjtBQUNBNEMscUJBQVcsQ0FBQzdNLEdBQUQsQ0FBWDtBQUNELFNBUEQsTUFPTztBQUNMLGNBQUlrTixXQUFXLEdBQUc3UixDQUFDLENBQUNVLEtBQUYsQ0FBUStMLGlCQUFpQixDQUFDM0UsUUFBMUIsQ0FBbEI7O0FBQ0EsY0FBSTZKLE1BQUosRUFBWTtBQUNWRSx1QkFBVyxDQUFDakQsRUFBWixHQUFpQjtBQUFDa0QsaUJBQUcsRUFBRUg7QUFBTixhQUFqQjtBQUNEOztBQUNERixnQkFBTSxHQUFHOU8sSUFBSSxDQUFDcUssd0JBQUwsQ0FBOEIsSUFBSXJCLGlCQUFKLENBQ3JDYyxpQkFBaUIsQ0FBQy9HLGNBRG1CLEVBRXJDbU0sV0FGcUMsRUFHckNwRixpQkFBaUIsQ0FBQy9KLE9BSG1CLENBQTlCLENBQVQsQ0FMSyxDQVNMO0FBQ0E7QUFDQTs7QUFDQXdCLGdCQUFNLENBQUNzTSxVQUFQLENBQWtCb0IsSUFBbEIsRUFBd0IsR0FBeEI7QUFDQTtBQUNEO0FBQ0Y7QUFDRixLQXpDRDs7QUEyQ0ExTixVQUFNLENBQUM2TixLQUFQLENBQWFILElBQWI7QUFFQSxXQUFPO0FBQ0xyTSxVQUFJLEVBQUUsWUFBWTtBQUNoQm1NLGVBQU8sR0FBRyxJQUFWO0FBQ0FELGNBQU0sQ0FBQ3JNLEtBQVA7QUFDRDtBQUpJLEtBQVA7QUFNRCxHQTVERDs7QUE4REE1QyxpQkFBZSxDQUFDL0IsU0FBaEIsQ0FBMEJ5TixlQUExQixHQUE0QyxVQUN4Q3pCLGlCQUR3QyxFQUNyQnFCLE9BRHFCLEVBQ1pKLFNBRFksRUFDRDtBQUN6QyxRQUFJL0ssSUFBSSxHQUFHLElBQVg7O0FBRUEsUUFBSThKLGlCQUFpQixDQUFDL0osT0FBbEIsQ0FBMEJxSyxRQUE5QixFQUF3QztBQUN0QyxhQUFPcEssSUFBSSxDQUFDcVAsdUJBQUwsQ0FBNkJ2RixpQkFBN0IsRUFBZ0RxQixPQUFoRCxFQUF5REosU0FBekQsQ0FBUDtBQUNELEtBTHdDLENBT3pDO0FBQ0E7OztBQUNBLFFBQUlqQixpQkFBaUIsQ0FBQy9KLE9BQWxCLENBQTBCOEwsTUFBMUIsS0FDQy9CLGlCQUFpQixDQUFDL0osT0FBbEIsQ0FBMEI4TCxNQUExQixDQUFpQzlHLEdBQWpDLEtBQXlDLENBQXpDLElBQ0ErRSxpQkFBaUIsQ0FBQy9KLE9BQWxCLENBQTBCOEwsTUFBMUIsQ0FBaUM5RyxHQUFqQyxLQUF5QyxLQUYxQyxDQUFKLEVBRXNEO0FBQ3BELFlBQU1yQyxLQUFLLENBQUMsc0RBQUQsQ0FBWDtBQUNEOztBQUVELFFBQUk0TSxVQUFVLEdBQUd0USxLQUFLLENBQUN1USxTQUFOLENBQ2ZsUyxDQUFDLENBQUNrSSxNQUFGLENBQVM7QUFBQzRGLGFBQU8sRUFBRUE7QUFBVixLQUFULEVBQTZCckIsaUJBQTdCLENBRGUsQ0FBakI7QUFHQSxRQUFJMEYsV0FBSixFQUFpQkMsYUFBakI7QUFDQSxRQUFJQyxXQUFXLEdBQUcsS0FBbEIsQ0FuQnlDLENBcUJ6QztBQUNBO0FBQ0E7O0FBQ0FuTyxVQUFNLENBQUNvTyxnQkFBUCxDQUF3QixZQUFZO0FBQ2xDLFVBQUl0UyxDQUFDLENBQUMwRCxHQUFGLENBQU1mLElBQUksQ0FBQ0Msb0JBQVgsRUFBaUNxUCxVQUFqQyxDQUFKLEVBQWtEO0FBQ2hERSxtQkFBVyxHQUFHeFAsSUFBSSxDQUFDQyxvQkFBTCxDQUEwQnFQLFVBQTFCLENBQWQ7QUFDRCxPQUZELE1BRU87QUFDTEksbUJBQVcsR0FBRyxJQUFkLENBREssQ0FFTDs7QUFDQUYsbUJBQVcsR0FBRyxJQUFJSSxrQkFBSixDQUF1QjtBQUNuQ3pFLGlCQUFPLEVBQUVBLE9BRDBCO0FBRW5DMEUsZ0JBQU0sRUFBRSxZQUFZO0FBQ2xCLG1CQUFPN1AsSUFBSSxDQUFDQyxvQkFBTCxDQUEwQnFQLFVBQTFCLENBQVA7QUFDQUcseUJBQWEsQ0FBQzdNLElBQWQ7QUFDRDtBQUxrQyxTQUF2QixDQUFkO0FBT0E1QyxZQUFJLENBQUNDLG9CQUFMLENBQTBCcVAsVUFBMUIsSUFBd0NFLFdBQXhDO0FBQ0Q7QUFDRixLQWZEOztBQWlCQSxRQUFJTSxhQUFhLEdBQUcsSUFBSUMsYUFBSixDQUFrQlAsV0FBbEIsRUFBK0J6RSxTQUEvQixDQUFwQjs7QUFFQSxRQUFJMkUsV0FBSixFQUFpQjtBQUNmLFVBQUlNLE9BQUosRUFBYUMsTUFBYjs7QUFDQSxVQUFJQyxXQUFXLEdBQUc3UyxDQUFDLENBQUM4UyxHQUFGLENBQU0sQ0FDdEIsWUFBWTtBQUNWO0FBQ0E7QUFDQTtBQUNBLGVBQU9uUSxJQUFJLENBQUNtQixZQUFMLElBQXFCLENBQUNnSyxPQUF0QixJQUNMLENBQUNKLFNBQVMsQ0FBQ3FGLHFCQURiO0FBRUQsT0FQcUIsRUFPbkIsWUFBWTtBQUNiO0FBQ0E7QUFDQSxZQUFJO0FBQ0ZKLGlCQUFPLEdBQUcsSUFBSUssU0FBUyxDQUFDQyxPQUFkLENBQXNCeEcsaUJBQWlCLENBQUMzRSxRQUF4QyxDQUFWO0FBQ0EsaUJBQU8sSUFBUDtBQUNELFNBSEQsQ0FHRSxPQUFPVCxDQUFQLEVBQVU7QUFDVjtBQUNBO0FBQ0EsaUJBQU8sS0FBUDtBQUNEO0FBQ0YsT0FsQnFCLEVBa0JuQixZQUFZO0FBQ2I7QUFDQSxlQUFPNkwsa0JBQWtCLENBQUNDLGVBQW5CLENBQW1DMUcsaUJBQW5DLEVBQXNEa0csT0FBdEQsQ0FBUDtBQUNELE9BckJxQixFQXFCbkIsWUFBWTtBQUNiO0FBQ0E7QUFDQSxZQUFJLENBQUNsRyxpQkFBaUIsQ0FBQy9KLE9BQWxCLENBQTBCMkwsSUFBL0IsRUFDRSxPQUFPLElBQVA7O0FBQ0YsWUFBSTtBQUNGdUUsZ0JBQU0sR0FBRyxJQUFJSSxTQUFTLENBQUNJLE1BQWQsQ0FBcUIzRyxpQkFBaUIsQ0FBQy9KLE9BQWxCLENBQTBCMkwsSUFBL0MsQ0FBVDtBQUNBLGlCQUFPLElBQVA7QUFDRCxTQUhELENBR0UsT0FBT2hILENBQVAsRUFBVTtBQUNWO0FBQ0E7QUFDQSxpQkFBTyxLQUFQO0FBQ0Q7QUFDRixPQWxDcUIsQ0FBTixFQWtDWixVQUFVZ00sQ0FBVixFQUFhO0FBQUUsZUFBT0EsQ0FBQyxFQUFSO0FBQWEsT0FsQ2hCLENBQWxCLENBRmUsQ0FvQ3VCOzs7QUFFdEMsVUFBSUMsV0FBVyxHQUFHVCxXQUFXLEdBQUdLLGtCQUFILEdBQXdCSyxvQkFBckQ7QUFDQW5CLG1CQUFhLEdBQUcsSUFBSWtCLFdBQUosQ0FBZ0I7QUFDOUI3Ryx5QkFBaUIsRUFBRUEsaUJBRFc7QUFFOUIrRyxtQkFBVyxFQUFFN1EsSUFGaUI7QUFHOUJ3UCxtQkFBVyxFQUFFQSxXQUhpQjtBQUk5QnJFLGVBQU8sRUFBRUEsT0FKcUI7QUFLOUI2RSxlQUFPLEVBQUVBLE9BTHFCO0FBS1g7QUFDbkJDLGNBQU0sRUFBRUEsTUFOc0I7QUFNYjtBQUNqQkcsNkJBQXFCLEVBQUVyRixTQUFTLENBQUNxRjtBQVBILE9BQWhCLENBQWhCLENBdkNlLENBaURmOztBQUNBWixpQkFBVyxDQUFDc0IsY0FBWixHQUE2QnJCLGFBQTdCO0FBQ0QsS0E5RndDLENBZ0d6Qzs7O0FBQ0FELGVBQVcsQ0FBQ3VCLDJCQUFaLENBQXdDakIsYUFBeEM7QUFFQSxXQUFPQSxhQUFQO0FBQ0QsR0FyR0QsQyxDQXVHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFFQWtCLFdBQVMsR0FBRyxVQUFVbEgsaUJBQVYsRUFBNkJtSCxjQUE3QixFQUE2QztBQUN2RCxRQUFJQyxTQUFTLEdBQUcsRUFBaEI7QUFDQUMsa0JBQWMsQ0FBQ3JILGlCQUFELEVBQW9CLFVBQVVzSCxPQUFWLEVBQW1CO0FBQ25ERixlQUFTLENBQUM1QyxJQUFWLENBQWU1SyxTQUFTLENBQUMyTixxQkFBVixDQUFnQ0MsTUFBaEMsQ0FDYkYsT0FEYSxFQUNKSCxjQURJLENBQWY7QUFFRCxLQUhhLENBQWQ7QUFLQSxXQUFPO0FBQ0xyTyxVQUFJLEVBQUUsWUFBWTtBQUNoQnZGLFNBQUMsQ0FBQ0ssSUFBRixDQUFPd1QsU0FBUCxFQUFrQixVQUFVSyxRQUFWLEVBQW9CO0FBQ3BDQSxrQkFBUSxDQUFDM08sSUFBVDtBQUNELFNBRkQ7QUFHRDtBQUxJLEtBQVA7QUFPRCxHQWREOztBQWdCQXVPLGdCQUFjLEdBQUcsVUFBVXJILGlCQUFWLEVBQTZCMEgsZUFBN0IsRUFBOEM7QUFDN0QsUUFBSTVULEdBQUcsR0FBRztBQUFDcUYsZ0JBQVUsRUFBRTZHLGlCQUFpQixDQUFDL0c7QUFBL0IsS0FBVjs7QUFDQSxRQUFJc0MsV0FBVyxHQUFHVCxlQUFlLENBQUNVLHFCQUFoQixDQUNoQndFLGlCQUFpQixDQUFDM0UsUUFERixDQUFsQjs7QUFFQSxRQUFJRSxXQUFKLEVBQWlCO0FBQ2ZoSSxPQUFDLENBQUNLLElBQUYsQ0FBTzJILFdBQVAsRUFBb0IsVUFBVVAsRUFBVixFQUFjO0FBQ2hDME0sdUJBQWUsQ0FBQ25VLENBQUMsQ0FBQ2tJLE1BQUYsQ0FBUztBQUFDVCxZQUFFLEVBQUVBO0FBQUwsU0FBVCxFQUFtQmxILEdBQW5CLENBQUQsQ0FBZjtBQUNELE9BRkQ7O0FBR0E0VCxxQkFBZSxDQUFDblUsQ0FBQyxDQUFDa0ksTUFBRixDQUFTO0FBQUNTLHNCQUFjLEVBQUUsSUFBakI7QUFBdUJsQixVQUFFLEVBQUU7QUFBM0IsT0FBVCxFQUEyQ2xILEdBQTNDLENBQUQsQ0FBZjtBQUNELEtBTEQsTUFLTztBQUNMNFQscUJBQWUsQ0FBQzVULEdBQUQsQ0FBZjtBQUNELEtBWDRELENBWTdEOzs7QUFDQTRULG1CQUFlLENBQUM7QUFBRXJMLGtCQUFZLEVBQUU7QUFBaEIsS0FBRCxDQUFmO0FBQ0QsR0FkRCxDLENBZ0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQXRHLGlCQUFlLENBQUMvQixTQUFoQixDQUEwQnVSLHVCQUExQixHQUFvRCxVQUNoRHZGLGlCQURnRCxFQUM3QnFCLE9BRDZCLEVBQ3BCSixTQURvQixFQUNUO0FBQ3pDLFFBQUkvSyxJQUFJLEdBQUcsSUFBWCxDQUR5QyxDQUd6QztBQUNBOztBQUNBLFFBQUttTCxPQUFPLElBQUksQ0FBQ0osU0FBUyxDQUFDMEcsV0FBdkIsSUFDQyxDQUFDdEcsT0FBRCxJQUFZLENBQUNKLFNBQVMsQ0FBQzJHLEtBRDVCLEVBQ29DO0FBQ2xDLFlBQU0sSUFBSWhQLEtBQUosQ0FBVSx1QkFBdUJ5SSxPQUFPLEdBQUcsU0FBSCxHQUFlLFdBQTdDLElBQ0UsNkJBREYsSUFFR0EsT0FBTyxHQUFHLGFBQUgsR0FBbUIsT0FGN0IsSUFFd0MsV0FGbEQsQ0FBTjtBQUdEOztBQUVELFdBQU9uTCxJQUFJLENBQUM0TyxJQUFMLENBQVU5RSxpQkFBVixFQUE2QixVQUFVOUgsR0FBVixFQUFlO0FBQ2pELFVBQUk4QyxFQUFFLEdBQUc5QyxHQUFHLENBQUMrQyxHQUFiO0FBQ0EsYUFBTy9DLEdBQUcsQ0FBQytDLEdBQVgsQ0FGaUQsQ0FHakQ7O0FBQ0EsYUFBTy9DLEdBQUcsQ0FBQ2lLLEVBQVg7O0FBQ0EsVUFBSWQsT0FBSixFQUFhO0FBQ1hKLGlCQUFTLENBQUMwRyxXQUFWLENBQXNCM00sRUFBdEIsRUFBMEI5QyxHQUExQixFQUErQixJQUEvQjtBQUNELE9BRkQsTUFFTztBQUNMK0ksaUJBQVMsQ0FBQzJHLEtBQVYsQ0FBZ0I1TSxFQUFoQixFQUFvQjlDLEdBQXBCO0FBQ0Q7QUFDRixLQVZNLENBQVA7QUFXRCxHQXhCRCxDLENBMEJBO0FBQ0E7QUFDQTs7O0FBQ0FyRixnQkFBYyxDQUFDZ1YsY0FBZixHQUFnQ3JWLE9BQU8sQ0FBQ3VCLFNBQXhDO0FBRUFsQixnQkFBYyxDQUFDaVYsVUFBZixHQUE0Qi9SLGVBQTVCOzs7Ozs7Ozs7Ozs7QUMxNkNBLElBQUl0RCxnQkFBSjtBQUFxQlMsTUFBTSxDQUFDWixJQUFQLENBQVksa0JBQVosRUFBK0I7QUFBQ0csa0JBQWdCLENBQUNGLENBQUQsRUFBRztBQUFDRSxvQkFBZ0IsR0FBQ0YsQ0FBakI7QUFBbUI7O0FBQXhDLENBQS9CLEVBQXlFLENBQXpFOztBQUFyQixJQUFJRyxNQUFNLEdBQUdDLEdBQUcsQ0FBQ0MsT0FBSixDQUFZLGVBQVosQ0FBYjs7QUFHQSxNQUFNO0FBQUVtQjtBQUFGLElBQWdCdEIsZ0JBQXRCO0FBRUF5UCxnQkFBZ0IsR0FBRyxVQUFuQjtBQUVBLElBQUk2RixjQUFjLEdBQUdDLE9BQU8sQ0FBQ0MsR0FBUixDQUFZQywyQkFBWixJQUEyQyxJQUFoRTtBQUNBLElBQUlDLFlBQVksR0FBRyxDQUFDSCxPQUFPLENBQUNDLEdBQVIsQ0FBWUcseUJBQWIsSUFBMEMsS0FBN0Q7O0FBRUEsSUFBSUMsTUFBTSxHQUFHLFVBQVVsRyxFQUFWLEVBQWM7QUFDekIsU0FBTyxlQUFlQSxFQUFFLENBQUNtRyxXQUFILEVBQWYsR0FBa0MsSUFBbEMsR0FBeUNuRyxFQUFFLENBQUNvRyxVQUFILEVBQXpDLEdBQTJELEdBQWxFO0FBQ0QsQ0FGRDs7QUFJQUMsT0FBTyxHQUFHLFVBQVVDLEVBQVYsRUFBYztBQUN0QixNQUFJQSxFQUFFLENBQUNBLEVBQUgsS0FBVSxHQUFkLEVBQ0UsT0FBT0EsRUFBRSxDQUFDQyxDQUFILENBQUt6TixHQUFaLENBREYsS0FFSyxJQUFJd04sRUFBRSxDQUFDQSxFQUFILEtBQVUsR0FBZCxFQUNILE9BQU9BLEVBQUUsQ0FBQ0MsQ0FBSCxDQUFLek4sR0FBWixDQURHLEtBRUEsSUFBSXdOLEVBQUUsQ0FBQ0EsRUFBSCxLQUFVLEdBQWQsRUFDSCxPQUFPQSxFQUFFLENBQUNFLEVBQUgsQ0FBTTFOLEdBQWIsQ0FERyxLQUVBLElBQUl3TixFQUFFLENBQUNBLEVBQUgsS0FBVSxHQUFkLEVBQ0gsTUFBTTdQLEtBQUssQ0FBQyxvREFDQTFELEtBQUssQ0FBQ3VRLFNBQU4sQ0FBZ0JnRCxFQUFoQixDQURELENBQVgsQ0FERyxLQUlILE1BQU03UCxLQUFLLENBQUMsaUJBQWlCMUQsS0FBSyxDQUFDdVEsU0FBTixDQUFnQmdELEVBQWhCLENBQWxCLENBQVg7QUFDSCxDQVpEOztBQWNBaFEsV0FBVyxHQUFHLFVBQVVGLFFBQVYsRUFBb0JxUSxNQUFwQixFQUE0QjtBQUN4QyxNQUFJMVMsSUFBSSxHQUFHLElBQVg7QUFDQUEsTUFBSSxDQUFDMlMsU0FBTCxHQUFpQnRRLFFBQWpCO0FBQ0FyQyxNQUFJLENBQUM0UyxPQUFMLEdBQWVGLE1BQWY7QUFFQTFTLE1BQUksQ0FBQzZTLHlCQUFMLEdBQWlDLElBQWpDO0FBQ0E3UyxNQUFJLENBQUM4UyxvQkFBTCxHQUE0QixJQUE1QjtBQUNBOVMsTUFBSSxDQUFDK1MsUUFBTCxHQUFnQixLQUFoQjtBQUNBL1MsTUFBSSxDQUFDZ1QsV0FBTCxHQUFtQixJQUFuQjtBQUNBaFQsTUFBSSxDQUFDaVQsWUFBTCxHQUFvQixJQUFJelcsTUFBSixFQUFwQjtBQUNBd0QsTUFBSSxDQUFDa1QsU0FBTCxHQUFpQixJQUFJeFAsU0FBUyxDQUFDeVAsU0FBZCxDQUF3QjtBQUN2Q0MsZUFBVyxFQUFFLGdCQUQwQjtBQUNSQyxZQUFRLEVBQUU7QUFERixHQUF4QixDQUFqQjtBQUdBclQsTUFBSSxDQUFDc1Qsa0JBQUwsR0FBMEI7QUFDeEJDLE1BQUUsRUFBRSxJQUFJQyxNQUFKLENBQVcsU0FBUyxDQUN0QmpTLE1BQU0sQ0FBQ2tTLGFBQVAsQ0FBcUJ6VCxJQUFJLENBQUM0UyxPQUFMLEdBQWUsR0FBcEMsQ0FEc0IsRUFFdEJyUixNQUFNLENBQUNrUyxhQUFQLENBQXFCLFlBQXJCLENBRnNCLEVBR3RCQyxJQUhzQixDQUdqQixHQUhpQixDQUFULEdBR0QsR0FIVixDQURvQjtBQU14QkMsT0FBRyxFQUFFLENBQ0g7QUFBRXBCLFFBQUUsRUFBRTtBQUFFcUIsV0FBRyxFQUFFLENBQUMsR0FBRCxFQUFNLEdBQU4sRUFBVyxHQUFYO0FBQVA7QUFBTixLQURHLEVBRUg7QUFDQTtBQUFFckIsUUFBRSxFQUFFLEdBQU47QUFBVyxnQkFBVTtBQUFFc0IsZUFBTyxFQUFFO0FBQVg7QUFBckIsS0FIRyxFQUlIO0FBQUV0QixRQUFFLEVBQUUsR0FBTjtBQUFXLHdCQUFrQjtBQUE3QixLQUpHLEVBS0g7QUFBRUEsUUFBRSxFQUFFLEdBQU47QUFBVyxvQkFBYztBQUFFc0IsZUFBTyxFQUFFO0FBQVg7QUFBekIsS0FMRztBQU5tQixHQUExQixDQWJ3QyxDQTRCeEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUNBN1QsTUFBSSxDQUFDOFQsa0JBQUwsR0FBMEIsRUFBMUI7QUFDQTlULE1BQUksQ0FBQytULGdCQUFMLEdBQXdCLElBQXhCO0FBRUEvVCxNQUFJLENBQUNnVSxxQkFBTCxHQUE2QixJQUFJN1QsSUFBSixDQUFTO0FBQ3BDOFQsd0JBQW9CLEVBQUU7QUFEYyxHQUFULENBQTdCO0FBSUFqVSxNQUFJLENBQUNrVSxXQUFMLEdBQW1CLElBQUkzUyxNQUFNLENBQUM0UyxpQkFBWCxFQUFuQjtBQUNBblUsTUFBSSxDQUFDb1UsYUFBTCxHQUFxQixLQUFyQjs7QUFFQXBVLE1BQUksQ0FBQ3FVLGFBQUw7QUFDRCxDQXpERDs7QUEyREFoWCxDQUFDLENBQUNrSSxNQUFGLENBQVNoRCxXQUFXLENBQUN6RSxTQUFyQixFQUFnQztBQUM5QjhFLE1BQUksRUFBRSxZQUFZO0FBQ2hCLFFBQUk1QyxJQUFJLEdBQUcsSUFBWDtBQUNBLFFBQUlBLElBQUksQ0FBQytTLFFBQVQsRUFDRTtBQUNGL1MsUUFBSSxDQUFDK1MsUUFBTCxHQUFnQixJQUFoQjtBQUNBLFFBQUkvUyxJQUFJLENBQUNnVCxXQUFULEVBQ0VoVCxJQUFJLENBQUNnVCxXQUFMLENBQWlCcFEsSUFBakIsR0FOYyxDQU9oQjtBQUNELEdBVDZCO0FBVTlCMFIsY0FBWSxFQUFFLFVBQVVsRCxPQUFWLEVBQW1CblAsUUFBbkIsRUFBNkI7QUFDekMsUUFBSWpDLElBQUksR0FBRyxJQUFYO0FBQ0EsUUFBSUEsSUFBSSxDQUFDK1MsUUFBVCxFQUNFLE1BQU0sSUFBSXJRLEtBQUosQ0FBVSx3Q0FBVixDQUFOLENBSHVDLENBS3pDOztBQUNBMUMsUUFBSSxDQUFDaVQsWUFBTCxDQUFrQjdRLElBQWxCOztBQUVBLFFBQUltUyxnQkFBZ0IsR0FBR3RTLFFBQXZCO0FBQ0FBLFlBQVEsR0FBR1YsTUFBTSxDQUFDQyxlQUFQLENBQXVCLFVBQVVnVCxZQUFWLEVBQXdCO0FBQ3hERCxzQkFBZ0IsQ0FBQ0MsWUFBRCxDQUFoQjtBQUNELEtBRlUsRUFFUixVQUFVL1MsR0FBVixFQUFlO0FBQ2hCRixZQUFNLENBQUNrVCxNQUFQLENBQWMseUJBQWQsRUFBeUNoVCxHQUF6QztBQUNELEtBSlUsQ0FBWDs7QUFLQSxRQUFJaVQsWUFBWSxHQUFHMVUsSUFBSSxDQUFDa1QsU0FBTCxDQUFlNUIsTUFBZixDQUFzQkYsT0FBdEIsRUFBK0JuUCxRQUEvQixDQUFuQjs7QUFDQSxXQUFPO0FBQ0xXLFVBQUksRUFBRSxZQUFZO0FBQ2hCOFIsb0JBQVksQ0FBQzlSLElBQWI7QUFDRDtBQUhJLEtBQVA7QUFLRCxHQTlCNkI7QUErQjlCO0FBQ0E7QUFDQStSLGtCQUFnQixFQUFFLFVBQVUxUyxRQUFWLEVBQW9CO0FBQ3BDLFFBQUlqQyxJQUFJLEdBQUcsSUFBWDtBQUNBLFFBQUlBLElBQUksQ0FBQytTLFFBQVQsRUFDRSxNQUFNLElBQUlyUSxLQUFKLENBQVUsNENBQVYsQ0FBTjtBQUNGLFdBQU8xQyxJQUFJLENBQUNnVSxxQkFBTCxDQUEyQmhRLFFBQTNCLENBQW9DL0IsUUFBcEMsQ0FBUDtBQUNELEdBdEM2QjtBQXVDOUI7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBMlMsbUJBQWlCLEVBQUUsWUFBWTtBQUM3QixRQUFJNVUsSUFBSSxHQUFHLElBQVg7QUFDQSxRQUFJQSxJQUFJLENBQUMrUyxRQUFULEVBQ0UsTUFBTSxJQUFJclEsS0FBSixDQUFVLDZDQUFWLENBQU4sQ0FIMkIsQ0FLN0I7QUFDQTs7QUFDQTFDLFFBQUksQ0FBQ2lULFlBQUwsQ0FBa0I3USxJQUFsQjs7QUFDQSxRQUFJeVMsU0FBSjs7QUFFQSxXQUFPLENBQUM3VSxJQUFJLENBQUMrUyxRQUFiLEVBQXVCO0FBQ3JCO0FBQ0E7QUFDQTtBQUNBLFVBQUk7QUFDRjhCLGlCQUFTLEdBQUc3VSxJQUFJLENBQUM2Uyx5QkFBTCxDQUErQjVKLE9BQS9CLENBQ1YrQyxnQkFEVSxFQUNRaE0sSUFBSSxDQUFDc1Qsa0JBRGIsRUFFVjtBQUFDekgsZ0JBQU0sRUFBRTtBQUFDSSxjQUFFLEVBQUU7QUFBTCxXQUFUO0FBQWtCUCxjQUFJLEVBQUU7QUFBQ29KLG9CQUFRLEVBQUUsQ0FBQztBQUFaO0FBQXhCLFNBRlUsQ0FBWjtBQUdBO0FBQ0QsT0FMRCxDQUtFLE9BQU9wUSxDQUFQLEVBQVU7QUFDVjtBQUNBO0FBQ0FuRCxjQUFNLENBQUNrVCxNQUFQLENBQWMsd0NBQWQsRUFBd0QvUCxDQUF4RDs7QUFDQW5ELGNBQU0sQ0FBQ3dULFdBQVAsQ0FBbUIsR0FBbkI7QUFDRDtBQUNGOztBQUVELFFBQUkvVSxJQUFJLENBQUMrUyxRQUFULEVBQ0U7O0FBRUYsUUFBSSxDQUFDOEIsU0FBTCxFQUFnQjtBQUNkO0FBQ0E7QUFDRDs7QUFFRCxRQUFJNUksRUFBRSxHQUFHNEksU0FBUyxDQUFDNUksRUFBbkI7QUFDQSxRQUFJLENBQUNBLEVBQUwsRUFDRSxNQUFNdkosS0FBSyxDQUFDLDZCQUE2QjFELEtBQUssQ0FBQ3VRLFNBQU4sQ0FBZ0JzRixTQUFoQixDQUE5QixDQUFYOztBQUVGLFFBQUk3VSxJQUFJLENBQUMrVCxnQkFBTCxJQUF5QjlILEVBQUUsQ0FBQytJLGVBQUgsQ0FBbUJoVixJQUFJLENBQUMrVCxnQkFBeEIsQ0FBN0IsRUFBd0U7QUFDdEU7QUFDQTtBQUNELEtBMUM0QixDQTZDN0I7QUFDQTtBQUNBOzs7QUFDQSxRQUFJa0IsV0FBVyxHQUFHalYsSUFBSSxDQUFDOFQsa0JBQUwsQ0FBd0JoTSxNQUExQzs7QUFDQSxXQUFPbU4sV0FBVyxHQUFHLENBQWQsR0FBa0IsQ0FBbEIsSUFBdUJqVixJQUFJLENBQUM4VCxrQkFBTCxDQUF3Qm1CLFdBQVcsR0FBRyxDQUF0QyxFQUF5Q2hKLEVBQXpDLENBQTRDaUosV0FBNUMsQ0FBd0RqSixFQUF4RCxDQUE5QixFQUEyRjtBQUN6RmdKLGlCQUFXO0FBQ1o7O0FBQ0QsUUFBSXZFLENBQUMsR0FBRyxJQUFJbFUsTUFBSixFQUFSOztBQUNBd0QsUUFBSSxDQUFDOFQsa0JBQUwsQ0FBd0JxQixNQUF4QixDQUErQkYsV0FBL0IsRUFBNEMsQ0FBNUMsRUFBK0M7QUFBQ2hKLFFBQUUsRUFBRUEsRUFBTDtBQUFTakosWUFBTSxFQUFFME47QUFBakIsS0FBL0M7O0FBQ0FBLEtBQUMsQ0FBQ3RPLElBQUY7QUFDRCxHQW5HNkI7QUFvRzlCaVMsZUFBYSxFQUFFLFlBQVk7QUFDekIsUUFBSXJVLElBQUksR0FBRyxJQUFYLENBRHlCLENBRXpCOztBQUNBLFFBQUlvVixVQUFVLEdBQUczWSxHQUFHLENBQUNDLE9BQUosQ0FBWSxhQUFaLENBQWpCOztBQUNBLFFBQUkwWSxVQUFVLENBQUNDLEtBQVgsQ0FBaUJyVixJQUFJLENBQUMyUyxTQUF0QixFQUFpQzJDLFFBQWpDLEtBQThDLE9BQWxELEVBQTJEO0FBQ3pELFlBQU01UyxLQUFLLENBQUMsNkRBQ0EscUJBREQsQ0FBWDtBQUVELEtBUHdCLENBU3pCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUNBMUMsUUFBSSxDQUFDOFMsb0JBQUwsR0FBNEIsSUFBSWpULGVBQUosQ0FDMUJHLElBQUksQ0FBQzJTLFNBRHFCLEVBQ1Y7QUFBQzNSLGNBQVEsRUFBRTtBQUFYLEtBRFUsQ0FBNUIsQ0FwQnlCLENBc0J6QjtBQUNBO0FBQ0E7O0FBQ0FoQixRQUFJLENBQUM2Uyx5QkFBTCxHQUFpQyxJQUFJaFQsZUFBSixDQUMvQkcsSUFBSSxDQUFDMlMsU0FEMEIsRUFDZjtBQUFDM1IsY0FBUSxFQUFFO0FBQVgsS0FEZSxDQUFqQyxDQXpCeUIsQ0E0QnpCO0FBQ0E7QUFDQTtBQUNBOztBQUNBLFFBQUkwUCxDQUFDLEdBQUcsSUFBSWxVLE1BQUosRUFBUjs7QUFDQXdELFFBQUksQ0FBQzZTLHlCQUFMLENBQStCNVIsRUFBL0IsQ0FBa0NzVSxLQUFsQyxHQUEwQ0MsT0FBMUMsQ0FDRTtBQUFFQyxjQUFRLEVBQUU7QUFBWixLQURGLEVBQ21CL0UsQ0FBQyxDQUFDdk8sUUFBRixFQURuQjs7QUFFQSxRQUFJUCxXQUFXLEdBQUc4TyxDQUFDLENBQUN0TyxJQUFGLEVBQWxCOztBQUVBLFFBQUksRUFBRVIsV0FBVyxJQUFJQSxXQUFXLENBQUM4VCxPQUE3QixDQUFKLEVBQTJDO0FBQ3pDLFlBQU1oVCxLQUFLLENBQUMsNkRBQ0EscUJBREQsQ0FBWDtBQUVELEtBeEN3QixDQTBDekI7OztBQUNBLFFBQUlpVCxjQUFjLEdBQUczVixJQUFJLENBQUM2Uyx5QkFBTCxDQUErQjVKLE9BQS9CLENBQ25CK0MsZ0JBRG1CLEVBQ0QsRUFEQyxFQUNHO0FBQUNOLFVBQUksRUFBRTtBQUFDb0osZ0JBQVEsRUFBRSxDQUFDO0FBQVosT0FBUDtBQUF1QmpKLFlBQU0sRUFBRTtBQUFDSSxVQUFFLEVBQUU7QUFBTDtBQUEvQixLQURILENBQXJCOztBQUdBLFFBQUkySixhQUFhLEdBQUd2WSxDQUFDLENBQUNVLEtBQUYsQ0FBUWlDLElBQUksQ0FBQ3NULGtCQUFiLENBQXBCOztBQUNBLFFBQUlxQyxjQUFKLEVBQW9CO0FBQ2xCO0FBQ0FDLG1CQUFhLENBQUMzSixFQUFkLEdBQW1CO0FBQUNrRCxXQUFHLEVBQUV3RyxjQUFjLENBQUMxSjtBQUFyQixPQUFuQixDQUZrQixDQUdsQjtBQUNBO0FBQ0E7O0FBQ0FqTSxVQUFJLENBQUMrVCxnQkFBTCxHQUF3QjRCLGNBQWMsQ0FBQzFKLEVBQXZDO0FBQ0Q7O0FBRUQsUUFBSW5DLGlCQUFpQixHQUFHLElBQUlkLGlCQUFKLENBQ3RCZ0QsZ0JBRHNCLEVBQ0o0SixhQURJLEVBQ1c7QUFBQ3hMLGNBQVEsRUFBRTtBQUFYLEtBRFgsQ0FBeEIsQ0F4RHlCLENBMkR6QjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBQ0FwSyxRQUFJLENBQUNnVCxXQUFMLEdBQW1CaFQsSUFBSSxDQUFDOFMsb0JBQUwsQ0FBMEJsRSxJQUExQixDQUNqQjlFLGlCQURpQixFQUVqQixVQUFVOUgsR0FBVixFQUFlO0FBQ2JoQyxVQUFJLENBQUNrVSxXQUFMLENBQWlCNUYsSUFBakIsQ0FBc0J0TSxHQUF0Qjs7QUFDQWhDLFVBQUksQ0FBQzZWLGlCQUFMO0FBQ0QsS0FMZ0IsRUFNakI1RCxZQU5pQixDQUFuQjs7QUFRQWpTLFFBQUksQ0FBQ2lULFlBQUwsQ0FBa0I2QyxNQUFsQjtBQUNELEdBOUs2QjtBQWdMOUJELG1CQUFpQixFQUFFLFlBQVk7QUFDN0IsUUFBSTdWLElBQUksR0FBRyxJQUFYO0FBQ0EsUUFBSUEsSUFBSSxDQUFDb1UsYUFBVCxFQUF3QjtBQUN4QnBVLFFBQUksQ0FBQ29VLGFBQUwsR0FBcUIsSUFBckI7QUFFQTdTLFVBQU0sQ0FBQzZOLEtBQVAsQ0FBYSxZQUFZO0FBQ3ZCO0FBQ0EsZUFBUzJHLFNBQVQsQ0FBbUIvVCxHQUFuQixFQUF3QjtBQUN0QixZQUFJQSxHQUFHLENBQUN1UixFQUFKLEtBQVcsWUFBZixFQUE2QjtBQUMzQixjQUFJdlIsR0FBRyxDQUFDd1EsQ0FBSixDQUFNd0QsUUFBVixFQUFvQjtBQUNsQjtBQUNBO0FBQ0EsZ0JBQUlDLGFBQWEsR0FBR2pVLEdBQUcsQ0FBQ2lLLEVBQXhCO0FBQ0FqSyxlQUFHLENBQUN3USxDQUFKLENBQU13RCxRQUFOLENBQWUxSyxPQUFmLENBQXVCaUgsRUFBRSxJQUFJO0FBQzNCO0FBQ0Esa0JBQUksQ0FBQ0EsRUFBRSxDQUFDdEcsRUFBUixFQUFZO0FBQ1ZzRyxrQkFBRSxDQUFDdEcsRUFBSCxHQUFRZ0ssYUFBUjtBQUNBQSw2QkFBYSxHQUFHQSxhQUFhLENBQUNDLEdBQWQsQ0FBa0JyWSxTQUFTLENBQUNzWSxHQUE1QixDQUFoQjtBQUNEOztBQUNESix1QkFBUyxDQUFDeEQsRUFBRCxDQUFUO0FBQ0QsYUFQRDtBQVFBO0FBQ0Q7O0FBQ0QsZ0JBQU0sSUFBSTdQLEtBQUosQ0FBVSxxQkFBcUIxRCxLQUFLLENBQUN1USxTQUFOLENBQWdCdk4sR0FBaEIsQ0FBL0IsQ0FBTjtBQUNEOztBQUVELGNBQU1vUCxPQUFPLEdBQUc7QUFDZHBMLHdCQUFjLEVBQUUsS0FERjtBQUVkRyxzQkFBWSxFQUFFLEtBRkE7QUFHZG9NLFlBQUUsRUFBRXZRO0FBSFUsU0FBaEI7O0FBTUEsWUFBSSxPQUFPQSxHQUFHLENBQUN1UixFQUFYLEtBQWtCLFFBQWxCLElBQ0F2UixHQUFHLENBQUN1UixFQUFKLENBQU82QyxVQUFQLENBQWtCcFcsSUFBSSxDQUFDNFMsT0FBTCxHQUFlLEdBQWpDLENBREosRUFDMkM7QUFDekN4QixpQkFBTyxDQUFDbk8sVUFBUixHQUFxQmpCLEdBQUcsQ0FBQ3VSLEVBQUosQ0FBTzhDLEtBQVAsQ0FBYXJXLElBQUksQ0FBQzRTLE9BQUwsQ0FBYTlLLE1BQWIsR0FBc0IsQ0FBbkMsQ0FBckI7QUFDRCxTQTVCcUIsQ0E4QnRCO0FBQ0E7OztBQUNBLFlBQUlzSixPQUFPLENBQUNuTyxVQUFSLEtBQXVCLE1BQTNCLEVBQW1DO0FBQ2pDLGNBQUlqQixHQUFHLENBQUN3USxDQUFKLENBQU1yTSxZQUFWLEVBQXdCO0FBQ3RCLG1CQUFPaUwsT0FBTyxDQUFDbk8sVUFBZjtBQUNBbU8sbUJBQU8sQ0FBQ2pMLFlBQVIsR0FBdUIsSUFBdkI7QUFDRCxXQUhELE1BR08sSUFBSTlJLENBQUMsQ0FBQzBELEdBQUYsQ0FBTWlCLEdBQUcsQ0FBQ3dRLENBQVYsRUFBYSxNQUFiLENBQUosRUFBMEI7QUFDL0JwQixtQkFBTyxDQUFDbk8sVUFBUixHQUFxQmpCLEdBQUcsQ0FBQ3dRLENBQUosQ0FBTXZNLElBQTNCO0FBQ0FtTCxtQkFBTyxDQUFDcEwsY0FBUixHQUF5QixJQUF6QjtBQUNBb0wsbUJBQU8sQ0FBQ3RNLEVBQVIsR0FBYSxJQUFiO0FBQ0QsV0FKTSxNQUlBO0FBQ0wsa0JBQU1wQyxLQUFLLENBQUMscUJBQXFCMUQsS0FBSyxDQUFDdVEsU0FBTixDQUFnQnZOLEdBQWhCLENBQXRCLENBQVg7QUFDRDtBQUVGLFNBWkQsTUFZTztBQUNMO0FBQ0FvUCxpQkFBTyxDQUFDdE0sRUFBUixHQUFhd04sT0FBTyxDQUFDdFEsR0FBRCxDQUFwQjtBQUNEOztBQUVEaEMsWUFBSSxDQUFDa1QsU0FBTCxDQUFlb0QsSUFBZixDQUFvQmxGLE9BQXBCO0FBQ0Q7O0FBRUQsVUFBSTtBQUNGLGVBQU8sQ0FBRXBSLElBQUksQ0FBQytTLFFBQVAsSUFDQSxDQUFFL1MsSUFBSSxDQUFDa1UsV0FBTCxDQUFpQnFDLE9BQWpCLEVBRFQsRUFDcUM7QUFDbkM7QUFDQTtBQUNBLGNBQUl2VyxJQUFJLENBQUNrVSxXQUFMLENBQWlCcE0sTUFBakIsR0FBMEIrSixjQUE5QixFQUE4QztBQUM1QyxnQkFBSWdELFNBQVMsR0FBRzdVLElBQUksQ0FBQ2tVLFdBQUwsQ0FBaUJzQyxHQUFqQixFQUFoQjs7QUFDQXhXLGdCQUFJLENBQUNrVSxXQUFMLENBQWlCdUMsS0FBakI7O0FBRUF6VyxnQkFBSSxDQUFDZ1UscUJBQUwsQ0FBMkJ0VyxJQUEzQixDQUFnQyxVQUFVdUUsUUFBVixFQUFvQjtBQUNsREEsc0JBQVE7QUFDUixxQkFBTyxJQUFQO0FBQ0QsYUFIRCxFQUo0QyxDQVM1QztBQUNBOzs7QUFDQWpDLGdCQUFJLENBQUMwVyxtQkFBTCxDQUF5QjdCLFNBQVMsQ0FBQzVJLEVBQW5DOztBQUNBO0FBQ0Q7O0FBRUQsZ0JBQU1qSyxHQUFHLEdBQUdoQyxJQUFJLENBQUNrVSxXQUFMLENBQWlCeUMsS0FBakIsRUFBWixDQWxCbUMsQ0FvQm5DOzs7QUFDQVosbUJBQVMsQ0FBQy9ULEdBQUQsQ0FBVCxDQXJCbUMsQ0F1Qm5DO0FBQ0E7O0FBQ0EsY0FBSUEsR0FBRyxDQUFDaUssRUFBUixFQUFZO0FBQ1ZqTSxnQkFBSSxDQUFDMFcsbUJBQUwsQ0FBeUIxVSxHQUFHLENBQUNpSyxFQUE3QjtBQUNELFdBRkQsTUFFTztBQUNMLGtCQUFNdkosS0FBSyxDQUFDLDZCQUE2QjFELEtBQUssQ0FBQ3VRLFNBQU4sQ0FBZ0J2TixHQUFoQixDQUE5QixDQUFYO0FBQ0Q7QUFDRjtBQUNGLE9BakNELFNBaUNVO0FBQ1JoQyxZQUFJLENBQUNvVSxhQUFMLEdBQXFCLEtBQXJCO0FBQ0Q7QUFDRixLQTFGRDtBQTJGRCxHQWhSNkI7QUFrUjlCc0MscUJBQW1CLEVBQUUsVUFBVXpLLEVBQVYsRUFBYztBQUNqQyxRQUFJak0sSUFBSSxHQUFHLElBQVg7QUFDQUEsUUFBSSxDQUFDK1QsZ0JBQUwsR0FBd0I5SCxFQUF4Qjs7QUFDQSxXQUFPLENBQUM1TyxDQUFDLENBQUNrWixPQUFGLENBQVV2VyxJQUFJLENBQUM4VCxrQkFBZixDQUFELElBQXVDOVQsSUFBSSxDQUFDOFQsa0JBQUwsQ0FBd0IsQ0FBeEIsRUFBMkI3SCxFQUEzQixDQUE4QitJLGVBQTlCLENBQThDaFYsSUFBSSxDQUFDK1QsZ0JBQW5ELENBQTlDLEVBQW9IO0FBQ2xILFVBQUk2QyxTQUFTLEdBQUc1VyxJQUFJLENBQUM4VCxrQkFBTCxDQUF3QjZDLEtBQXhCLEVBQWhCOztBQUNBQyxlQUFTLENBQUM1VCxNQUFWLENBQWlCOFMsTUFBakI7QUFDRDtBQUNGLEdBelI2QjtBQTJSOUI7QUFDQWUscUJBQW1CLEVBQUUsVUFBU2xaLEtBQVQsRUFBZ0I7QUFDbkNrVSxrQkFBYyxHQUFHbFUsS0FBakI7QUFDRCxHQTlSNkI7QUErUjlCbVosb0JBQWtCLEVBQUUsWUFBVztBQUM3QmpGLGtCQUFjLEdBQUdDLE9BQU8sQ0FBQ0MsR0FBUixDQUFZQywyQkFBWixJQUEyQyxJQUE1RDtBQUNEO0FBalM2QixDQUFoQyxFOzs7Ozs7Ozs7OztBQ3ZGQSxJQUFJeFYsTUFBTSxHQUFHQyxHQUFHLENBQUNDLE9BQUosQ0FBWSxlQUFaLENBQWI7O0FBRUFrVCxrQkFBa0IsR0FBRyxVQUFVN1AsT0FBVixFQUFtQjtBQUN0QyxNQUFJQyxJQUFJLEdBQUcsSUFBWDtBQUVBLE1BQUksQ0FBQ0QsT0FBRCxJQUFZLENBQUMxQyxDQUFDLENBQUMwRCxHQUFGLENBQU1oQixPQUFOLEVBQWUsU0FBZixDQUFqQixFQUNFLE1BQU0yQyxLQUFLLENBQUMsd0JBQUQsQ0FBWDtBQUVGSixTQUFPLENBQUMsWUFBRCxDQUFQLElBQXlCQSxPQUFPLENBQUMsWUFBRCxDQUFQLENBQXNCeVUsS0FBdEIsQ0FBNEJDLG1CQUE1QixDQUN2QixnQkFEdUIsRUFDTCxzQkFESyxFQUNtQixDQURuQixDQUF6QjtBQUdBaFgsTUFBSSxDQUFDaVgsUUFBTCxHQUFnQmxYLE9BQU8sQ0FBQ29MLE9BQXhCOztBQUNBbkwsTUFBSSxDQUFDa1gsT0FBTCxHQUFlblgsT0FBTyxDQUFDOFAsTUFBUixJQUFrQixZQUFZLENBQUUsQ0FBL0M7O0FBQ0E3UCxNQUFJLENBQUNtWCxNQUFMLEdBQWMsSUFBSTVWLE1BQU0sQ0FBQzZWLGlCQUFYLEVBQWQ7QUFDQXBYLE1BQUksQ0FBQ3FYLFFBQUwsR0FBZ0IsRUFBaEI7QUFDQXJYLE1BQUksQ0FBQ2lULFlBQUwsR0FBb0IsSUFBSXpXLE1BQUosRUFBcEI7QUFDQXdELE1BQUksQ0FBQ3NYLE1BQUwsR0FBYyxJQUFJMVMsZUFBZSxDQUFDMlMsc0JBQXBCLENBQTJDO0FBQ3ZEcE0sV0FBTyxFQUFFcEwsT0FBTyxDQUFDb0w7QUFEc0MsR0FBM0MsQ0FBZCxDQWRzQyxDQWdCdEM7QUFDQTtBQUNBOztBQUNBbkwsTUFBSSxDQUFDd1gsdUNBQUwsR0FBK0MsQ0FBL0M7O0FBRUFuYSxHQUFDLENBQUNLLElBQUYsQ0FBT3NDLElBQUksQ0FBQ3lYLGFBQUwsRUFBUCxFQUE2QixVQUFVQyxZQUFWLEVBQXdCO0FBQ25EMVgsUUFBSSxDQUFDMFgsWUFBRCxDQUFKLEdBQXFCO0FBQVU7QUFBVztBQUN4QzFYLFVBQUksQ0FBQzJYLGNBQUwsQ0FBb0JELFlBQXBCLEVBQWtDcmEsQ0FBQyxDQUFDdWEsT0FBRixDQUFVL08sU0FBVixDQUFsQztBQUNELEtBRkQ7QUFHRCxHQUpEO0FBS0QsQ0ExQkQ7O0FBNEJBeEwsQ0FBQyxDQUFDa0ksTUFBRixDQUFTcUssa0JBQWtCLENBQUM5UixTQUE1QixFQUF1QztBQUNyQ2lULDZCQUEyQixFQUFFLFVBQVU4RyxNQUFWLEVBQWtCO0FBQzdDLFFBQUk3WCxJQUFJLEdBQUcsSUFBWCxDQUQ2QyxDQUc3QztBQUNBO0FBQ0E7QUFDQTs7QUFDQSxRQUFJLENBQUNBLElBQUksQ0FBQ21YLE1BQUwsQ0FBWVcsYUFBWixFQUFMLEVBQ0UsTUFBTSxJQUFJcFYsS0FBSixDQUFVLHNFQUFWLENBQU47QUFDRixNQUFFMUMsSUFBSSxDQUFDd1gsdUNBQVA7QUFFQWxWLFdBQU8sQ0FBQyxZQUFELENBQVAsSUFBeUJBLE9BQU8sQ0FBQyxZQUFELENBQVAsQ0FBc0J5VSxLQUF0QixDQUE0QkMsbUJBQTVCLENBQ3ZCLGdCQUR1QixFQUNMLGlCQURLLEVBQ2MsQ0FEZCxDQUF6Qjs7QUFHQWhYLFFBQUksQ0FBQ21YLE1BQUwsQ0FBWVksT0FBWixDQUFvQixZQUFZO0FBQzlCL1gsVUFBSSxDQUFDcVgsUUFBTCxDQUFjUSxNQUFNLENBQUM5UyxHQUFyQixJQUE0QjhTLE1BQTVCLENBRDhCLENBRTlCO0FBQ0E7O0FBQ0E3WCxVQUFJLENBQUNnWSxTQUFMLENBQWVILE1BQWY7O0FBQ0EsUUFBRTdYLElBQUksQ0FBQ3dYLHVDQUFQO0FBQ0QsS0FORCxFQWQ2QyxDQXFCN0M7OztBQUNBeFgsUUFBSSxDQUFDaVQsWUFBTCxDQUFrQjdRLElBQWxCO0FBQ0QsR0F4Qm9DO0FBMEJyQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTZWLGNBQVksRUFBRSxVQUFVblQsRUFBVixFQUFjO0FBQzFCLFFBQUk5RSxJQUFJLEdBQUcsSUFBWCxDQUQwQixDQUcxQjtBQUNBO0FBQ0E7O0FBQ0EsUUFBSSxDQUFDQSxJQUFJLENBQUNrWSxNQUFMLEVBQUwsRUFDRSxNQUFNLElBQUl4VixLQUFKLENBQVUsbURBQVYsQ0FBTjtBQUVGLFdBQU8xQyxJQUFJLENBQUNxWCxRQUFMLENBQWN2UyxFQUFkLENBQVA7QUFFQXhDLFdBQU8sQ0FBQyxZQUFELENBQVAsSUFBeUJBLE9BQU8sQ0FBQyxZQUFELENBQVAsQ0FBc0J5VSxLQUF0QixDQUE0QkMsbUJBQTVCLENBQ3ZCLGdCQUR1QixFQUNMLGlCQURLLEVBQ2MsQ0FBQyxDQURmLENBQXpCOztBQUdBLFFBQUkzWixDQUFDLENBQUNrWixPQUFGLENBQVV2VyxJQUFJLENBQUNxWCxRQUFmLEtBQ0FyWCxJQUFJLENBQUN3WCx1Q0FBTCxLQUFpRCxDQURyRCxFQUN3RDtBQUN0RHhYLFVBQUksQ0FBQ21ZLEtBQUw7QUFDRDtBQUNGLEdBbERvQztBQW1EckNBLE9BQUssRUFBRSxVQUFVcFksT0FBVixFQUFtQjtBQUN4QixRQUFJQyxJQUFJLEdBQUcsSUFBWDtBQUNBRCxXQUFPLEdBQUdBLE9BQU8sSUFBSSxFQUFyQixDQUZ3QixDQUl4QjtBQUNBOztBQUNBLFFBQUksQ0FBRUMsSUFBSSxDQUFDa1ksTUFBTCxFQUFGLElBQW1CLENBQUVuWSxPQUFPLENBQUNxWSxjQUFqQyxFQUNFLE1BQU0xVixLQUFLLENBQUMsNkJBQUQsQ0FBWCxDQVBzQixDQVN4QjtBQUNBOztBQUNBMUMsUUFBSSxDQUFDa1gsT0FBTDs7QUFDQTVVLFdBQU8sQ0FBQyxZQUFELENBQVAsSUFBeUJBLE9BQU8sQ0FBQyxZQUFELENBQVAsQ0FBc0J5VSxLQUF0QixDQUE0QkMsbUJBQTVCLENBQ3ZCLGdCQUR1QixFQUNMLHNCQURLLEVBQ21CLENBQUMsQ0FEcEIsQ0FBekIsQ0Fad0IsQ0FleEI7QUFDQTs7QUFDQWhYLFFBQUksQ0FBQ3FYLFFBQUwsR0FBZ0IsSUFBaEI7QUFDRCxHQXJFb0M7QUF1RXJDO0FBQ0E7QUFDQWdCLE9BQUssRUFBRSxZQUFZO0FBQ2pCLFFBQUlyWSxJQUFJLEdBQUcsSUFBWDs7QUFDQUEsUUFBSSxDQUFDbVgsTUFBTCxDQUFZbUIsU0FBWixDQUFzQixZQUFZO0FBQ2hDLFVBQUl0WSxJQUFJLENBQUNrWSxNQUFMLEVBQUosRUFDRSxNQUFNeFYsS0FBSyxDQUFDLDBDQUFELENBQVg7O0FBQ0YxQyxVQUFJLENBQUNpVCxZQUFMLENBQWtCNkMsTUFBbEI7QUFDRCxLQUpEO0FBS0QsR0FoRm9DO0FBa0ZyQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQXlDLFlBQVUsRUFBRSxVQUFVOVcsR0FBVixFQUFlO0FBQ3pCLFFBQUl6QixJQUFJLEdBQUcsSUFBWDs7QUFDQUEsUUFBSSxDQUFDbVgsTUFBTCxDQUFZWSxPQUFaLENBQW9CLFlBQVk7QUFDOUIsVUFBSS9YLElBQUksQ0FBQ2tZLE1BQUwsRUFBSixFQUNFLE1BQU14VixLQUFLLENBQUMsaURBQUQsQ0FBWDs7QUFDRjFDLFVBQUksQ0FBQ21ZLEtBQUwsQ0FBVztBQUFDQyxzQkFBYyxFQUFFO0FBQWpCLE9BQVg7O0FBQ0FwWSxVQUFJLENBQUNpVCxZQUFMLENBQWtCdUYsS0FBbEIsQ0FBd0IvVyxHQUF4QjtBQUNELEtBTEQ7QUFNRCxHQWhHb0M7QUFrR3JDO0FBQ0E7QUFDQTtBQUNBZ1gsU0FBTyxFQUFFLFVBQVUxUyxFQUFWLEVBQWM7QUFDckIsUUFBSS9GLElBQUksR0FBRyxJQUFYOztBQUNBQSxRQUFJLENBQUNtWCxNQUFMLENBQVltQixTQUFaLENBQXNCLFlBQVk7QUFDaEMsVUFBSSxDQUFDdFksSUFBSSxDQUFDa1ksTUFBTCxFQUFMLEVBQ0UsTUFBTXhWLEtBQUssQ0FBQyx1REFBRCxDQUFYO0FBQ0ZxRCxRQUFFO0FBQ0gsS0FKRDtBQUtELEdBNUdvQztBQTZHckMwUixlQUFhLEVBQUUsWUFBWTtBQUN6QixRQUFJelgsSUFBSSxHQUFHLElBQVg7QUFDQSxRQUFJQSxJQUFJLENBQUNpWCxRQUFULEVBQ0UsT0FBTyxDQUFDLGFBQUQsRUFBZ0IsU0FBaEIsRUFBMkIsYUFBM0IsRUFBMEMsU0FBMUMsQ0FBUCxDQURGLEtBR0UsT0FBTyxDQUFDLE9BQUQsRUFBVSxTQUFWLEVBQXFCLFNBQXJCLENBQVA7QUFDSCxHQW5Ib0M7QUFvSHJDaUIsUUFBTSxFQUFFLFlBQVk7QUFDbEIsV0FBTyxLQUFLakYsWUFBTCxDQUFrQnlGLFVBQWxCLEVBQVA7QUFDRCxHQXRIb0M7QUF1SHJDZixnQkFBYyxFQUFFLFVBQVVELFlBQVYsRUFBd0JpQixJQUF4QixFQUE4QjtBQUM1QyxRQUFJM1ksSUFBSSxHQUFHLElBQVg7O0FBQ0FBLFFBQUksQ0FBQ21YLE1BQUwsQ0FBWW1CLFNBQVosQ0FBc0IsWUFBWTtBQUNoQztBQUNBLFVBQUksQ0FBQ3RZLElBQUksQ0FBQ3FYLFFBQVYsRUFDRSxPQUg4QixDQUtoQztBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUNBclgsVUFBSSxDQUFDc1gsTUFBTCxDQUFZc0IsV0FBWixDQUF3QmxCLFlBQXhCLEVBQXNDOU8sS0FBdEMsQ0FBNEMsSUFBNUMsRUFBa0Q1SixLQUFLLENBQUNqQixLQUFOLENBQVk0YSxJQUFaLENBQWxELEVBVmdDLENBWWhDO0FBQ0E7OztBQUNBLFVBQUksQ0FBQzNZLElBQUksQ0FBQ2tZLE1BQUwsRUFBRCxJQUNDUixZQUFZLEtBQUssT0FBakIsSUFBNEJBLFlBQVksS0FBSyxhQURsRCxFQUNrRTtBQUNoRSxjQUFNLElBQUloVixLQUFKLENBQVUsU0FBU2dWLFlBQVQsR0FBd0Isc0JBQWxDLENBQU47QUFDRCxPQWpCK0IsQ0FtQmhDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUNBcmEsT0FBQyxDQUFDSyxJQUFGLENBQU9MLENBQUMsQ0FBQ3diLElBQUYsQ0FBTzdZLElBQUksQ0FBQ3FYLFFBQVosQ0FBUCxFQUE4QixVQUFVeUIsUUFBVixFQUFvQjtBQUNoRCxZQUFJakIsTUFBTSxHQUFHN1gsSUFBSSxDQUFDcVgsUUFBTCxJQUFpQnJYLElBQUksQ0FBQ3FYLFFBQUwsQ0FBY3lCLFFBQWQsQ0FBOUI7QUFDQSxZQUFJLENBQUNqQixNQUFMLEVBQ0U7QUFDRixZQUFJNVYsUUFBUSxHQUFHNFYsTUFBTSxDQUFDLE1BQU1ILFlBQVAsQ0FBckIsQ0FKZ0QsQ0FLaEQ7O0FBQ0F6VixnQkFBUSxJQUFJQSxRQUFRLENBQUMyRyxLQUFULENBQWUsSUFBZixFQUFxQjVKLEtBQUssQ0FBQ2pCLEtBQU4sQ0FBWTRhLElBQVosQ0FBckIsQ0FBWjtBQUNELE9BUEQ7QUFRRCxLQWhDRDtBQWlDRCxHQTFKb0M7QUE0SnJDO0FBQ0E7QUFDQTtBQUNBO0FBQ0FYLFdBQVMsRUFBRSxVQUFVSCxNQUFWLEVBQWtCO0FBQzNCLFFBQUk3WCxJQUFJLEdBQUcsSUFBWDtBQUNBLFFBQUlBLElBQUksQ0FBQ21YLE1BQUwsQ0FBWVcsYUFBWixFQUFKLEVBQ0UsTUFBTXBWLEtBQUssQ0FBQyxrREFBRCxDQUFYO0FBQ0YsUUFBSXdULEdBQUcsR0FBR2xXLElBQUksQ0FBQ2lYLFFBQUwsR0FBZ0JZLE1BQU0sQ0FBQ2tCLFlBQXZCLEdBQXNDbEIsTUFBTSxDQUFDbUIsTUFBdkQ7QUFDQSxRQUFJLENBQUM5QyxHQUFMLEVBQ0UsT0FOeUIsQ0FPM0I7O0FBQ0FsVyxRQUFJLENBQUNzWCxNQUFMLENBQVkyQixJQUFaLENBQWlCM04sT0FBakIsQ0FBeUIsVUFBVXRKLEdBQVYsRUFBZThDLEVBQWYsRUFBbUI7QUFDMUMsVUFBSSxDQUFDekgsQ0FBQyxDQUFDMEQsR0FBRixDQUFNZixJQUFJLENBQUNxWCxRQUFYLEVBQXFCUSxNQUFNLENBQUM5UyxHQUE1QixDQUFMLEVBQ0UsTUFBTXJDLEtBQUssQ0FBQyxpREFBRCxDQUFYO0FBQ0YsVUFBSW1KLE1BQU0sR0FBRzdNLEtBQUssQ0FBQ2pCLEtBQU4sQ0FBWWlFLEdBQVosQ0FBYjtBQUNBLGFBQU82SixNQUFNLENBQUM5RyxHQUFkO0FBQ0EsVUFBSS9FLElBQUksQ0FBQ2lYLFFBQVQsRUFDRWYsR0FBRyxDQUFDcFIsRUFBRCxFQUFLK0csTUFBTCxFQUFhLElBQWIsQ0FBSCxDQURGLENBQ3lCO0FBRHpCLFdBR0VxSyxHQUFHLENBQUNwUixFQUFELEVBQUsrRyxNQUFMLENBQUg7QUFDSCxLQVREO0FBVUQ7QUFsTG9DLENBQXZDOztBQXNMQSxJQUFJcU4sbUJBQW1CLEdBQUcsQ0FBMUI7O0FBQ0FuSixhQUFhLEdBQUcsVUFBVVAsV0FBVixFQUF1QnpFLFNBQXZCLEVBQWtDO0FBQ2hELE1BQUkvSyxJQUFJLEdBQUcsSUFBWCxDQURnRCxDQUVoRDtBQUNBOztBQUNBQSxNQUFJLENBQUNtWixZQUFMLEdBQW9CM0osV0FBcEI7O0FBQ0FuUyxHQUFDLENBQUNLLElBQUYsQ0FBTzhSLFdBQVcsQ0FBQ2lJLGFBQVosRUFBUCxFQUFvQyxVQUFVeFosSUFBVixFQUFnQjtBQUNsRCxRQUFJOE0sU0FBUyxDQUFDOU0sSUFBRCxDQUFiLEVBQXFCO0FBQ25CK0IsVUFBSSxDQUFDLE1BQU0vQixJQUFQLENBQUosR0FBbUI4TSxTQUFTLENBQUM5TSxJQUFELENBQTVCO0FBQ0QsS0FGRCxNQUVPLElBQUlBLElBQUksS0FBSyxhQUFULElBQTBCOE0sU0FBUyxDQUFDMkcsS0FBeEMsRUFBK0M7QUFDcEQ7QUFDQTtBQUNBO0FBQ0E7QUFDQTFSLFVBQUksQ0FBQytZLFlBQUwsR0FBb0IsVUFBVWpVLEVBQVYsRUFBYytHLE1BQWQsRUFBc0J1TixNQUF0QixFQUE4QjtBQUNoRHJPLGlCQUFTLENBQUMyRyxLQUFWLENBQWdCNU0sRUFBaEIsRUFBb0IrRyxNQUFwQjtBQUNELE9BRkQ7QUFHRDtBQUNGLEdBWkQ7O0FBYUE3TCxNQUFJLENBQUMrUyxRQUFMLEdBQWdCLEtBQWhCO0FBQ0EvUyxNQUFJLENBQUMrRSxHQUFMLEdBQVdtVSxtQkFBbUIsRUFBOUI7QUFDRCxDQXBCRDs7QUFxQkFuSixhQUFhLENBQUNqUyxTQUFkLENBQXdCOEUsSUFBeEIsR0FBK0IsWUFBWTtBQUN6QyxNQUFJNUMsSUFBSSxHQUFHLElBQVg7QUFDQSxNQUFJQSxJQUFJLENBQUMrUyxRQUFULEVBQ0U7QUFDRi9TLE1BQUksQ0FBQytTLFFBQUwsR0FBZ0IsSUFBaEI7O0FBQ0EvUyxNQUFJLENBQUNtWixZQUFMLENBQWtCbEIsWUFBbEIsQ0FBK0JqWSxJQUFJLENBQUMrRSxHQUFwQztBQUNELENBTkQsQzs7Ozs7Ozs7Ozs7QUMxT0EvSCxNQUFNLENBQUNxYyxNQUFQLENBQWM7QUFBQ25kLFlBQVUsRUFBQyxNQUFJQTtBQUFoQixDQUFkOztBQUFBLElBQUlvZCxLQUFLLEdBQUc3YyxHQUFHLENBQUNDLE9BQUosQ0FBWSxRQUFaLENBQVo7O0FBRU8sTUFBTVIsVUFBTixDQUFpQjtBQUN0QnFkLGFBQVcsQ0FBQ0MsZUFBRCxFQUFrQjtBQUMzQixTQUFLQyxnQkFBTCxHQUF3QkQsZUFBeEIsQ0FEMkIsQ0FFM0I7O0FBQ0EsU0FBS0UsZUFBTCxHQUF1QixJQUFJQyxHQUFKLEVBQXZCO0FBQ0QsR0FMcUIsQ0FPdEI7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQXhRLE9BQUssQ0FBQ3BHLGNBQUQsRUFBaUIrQixFQUFqQixFQUFxQnlOLEVBQXJCLEVBQXlCdFEsUUFBekIsRUFBbUM7QUFDdEMsVUFBTWpDLElBQUksR0FBRyxJQUFiO0FBRUE0WixTQUFLLENBQUM3VyxjQUFELEVBQWlCOFcsTUFBakIsQ0FBTDtBQUNBRCxTQUFLLENBQUNySCxFQUFELEVBQUtsUyxNQUFMLENBQUwsQ0FKc0MsQ0FNdEM7QUFDQTs7QUFDQSxRQUFJTCxJQUFJLENBQUMwWixlQUFMLENBQXFCM1ksR0FBckIsQ0FBeUJ3UixFQUF6QixDQUFKLEVBQWtDO0FBQ2hDdlMsVUFBSSxDQUFDMFosZUFBTCxDQUFxQjlWLEdBQXJCLENBQXlCMk8sRUFBekIsRUFBNkJqRSxJQUE3QixDQUFrQ3JNLFFBQWxDOztBQUNBO0FBQ0Q7O0FBRUQsVUFBTThJLFNBQVMsR0FBRyxDQUFDOUksUUFBRCxDQUFsQjs7QUFDQWpDLFFBQUksQ0FBQzBaLGVBQUwsQ0FBcUJwTSxHQUFyQixDQUF5QmlGLEVBQXpCLEVBQTZCeEgsU0FBN0I7O0FBRUF1TyxTQUFLLENBQUMsWUFBWTtBQUNoQixVQUFJO0FBQ0YsWUFBSXRYLEdBQUcsR0FBR2hDLElBQUksQ0FBQ3laLGdCQUFMLENBQXNCeFEsT0FBdEIsQ0FDUmxHLGNBRFEsRUFDUTtBQUFDZ0MsYUFBRyxFQUFFRDtBQUFOLFNBRFIsS0FDc0IsSUFEaEMsQ0FERSxDQUdGO0FBQ0E7O0FBQ0EsZUFBT2lHLFNBQVMsQ0FBQ2pELE1BQVYsR0FBbUIsQ0FBMUIsRUFBNkI7QUFDM0I7QUFDQTtBQUNBO0FBQ0E7QUFDQWlELG1CQUFTLENBQUN5TCxHQUFWLEdBQWdCLElBQWhCLEVBQXNCeFgsS0FBSyxDQUFDakIsS0FBTixDQUFZaUUsR0FBWixDQUF0QjtBQUNEO0FBQ0YsT0FaRCxDQVlFLE9BQU8wQyxDQUFQLEVBQVU7QUFDVixlQUFPcUcsU0FBUyxDQUFDakQsTUFBVixHQUFtQixDQUExQixFQUE2QjtBQUMzQmlELG1CQUFTLENBQUN5TCxHQUFWLEdBQWdCOVIsQ0FBaEI7QUFDRDtBQUNGLE9BaEJELFNBZ0JVO0FBQ1I7QUFDQTtBQUNBMUUsWUFBSSxDQUFDMFosZUFBTCxDQUFxQkksTUFBckIsQ0FBNEJ2SCxFQUE1QjtBQUNEO0FBQ0YsS0F0QkksQ0FBTCxDQXNCR3dILEdBdEJIO0FBdUJEOztBQXZEcUIsQzs7Ozs7Ozs7Ozs7QUNGeEIsSUFBSUMsbUJBQW1CLEdBQUcsQ0FBQ2xJLE9BQU8sQ0FBQ0MsR0FBUixDQUFZa0ksMEJBQWIsSUFBMkMsRUFBckU7QUFDQSxJQUFJQyxtQkFBbUIsR0FBRyxDQUFDcEksT0FBTyxDQUFDQyxHQUFSLENBQVlvSSwwQkFBYixJQUEyQyxLQUFLLElBQTFFOztBQUVBdkosb0JBQW9CLEdBQUcsVUFBVTdRLE9BQVYsRUFBbUI7QUFDeEMsTUFBSUMsSUFBSSxHQUFHLElBQVg7QUFFQUEsTUFBSSxDQUFDZ0ssa0JBQUwsR0FBMEJqSyxPQUFPLENBQUMrSixpQkFBbEM7QUFDQTlKLE1BQUksQ0FBQ29hLFlBQUwsR0FBb0JyYSxPQUFPLENBQUM4USxXQUE1QjtBQUNBN1EsTUFBSSxDQUFDaVgsUUFBTCxHQUFnQmxYLE9BQU8sQ0FBQ29MLE9BQXhCO0FBQ0FuTCxNQUFJLENBQUNtWixZQUFMLEdBQW9CcFosT0FBTyxDQUFDeVAsV0FBNUI7QUFDQXhQLE1BQUksQ0FBQ3FhLGNBQUwsR0FBc0IsRUFBdEI7QUFDQXJhLE1BQUksQ0FBQytTLFFBQUwsR0FBZ0IsS0FBaEI7QUFFQS9TLE1BQUksQ0FBQ2lLLGtCQUFMLEdBQTBCakssSUFBSSxDQUFDb2EsWUFBTCxDQUFrQi9QLHdCQUFsQixDQUN4QnJLLElBQUksQ0FBQ2dLLGtCQURtQixDQUExQixDQVZ3QyxDQWF4QztBQUNBOztBQUNBaEssTUFBSSxDQUFDc2EsUUFBTCxHQUFnQixJQUFoQixDQWZ3QyxDQWlCeEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBQ0F0YSxNQUFJLENBQUN1YSw0QkFBTCxHQUFvQyxDQUFwQztBQUNBdmEsTUFBSSxDQUFDd2EsY0FBTCxHQUFzQixFQUF0QixDQXpCd0MsQ0F5QmQ7QUFFMUI7QUFDQTs7QUFDQXhhLE1BQUksQ0FBQ3lhLHNCQUFMLEdBQThCcGQsQ0FBQyxDQUFDcWQsUUFBRixDQUM1QjFhLElBQUksQ0FBQzJhLGlDQUR1QixFQUU1QjNhLElBQUksQ0FBQ2dLLGtCQUFMLENBQXdCakssT0FBeEIsQ0FBZ0M2YSxpQkFBaEMsSUFBcURaO0FBQW9CO0FBRjdDLEdBQTlCLENBN0J3QyxDQWlDeEM7O0FBQ0FoYSxNQUFJLENBQUM2YSxVQUFMLEdBQWtCLElBQUl0WixNQUFNLENBQUM2VixpQkFBWCxFQUFsQjtBQUVBLE1BQUkwRCxlQUFlLEdBQUc5SixTQUFTLENBQzdCaFIsSUFBSSxDQUFDZ0ssa0JBRHdCLEVBQ0osVUFBVXdLLFlBQVYsRUFBd0I7QUFDL0M7QUFDQTtBQUNBO0FBQ0EsUUFBSS9RLEtBQUssR0FBR0MsU0FBUyxDQUFDQyxrQkFBVixDQUE2QkMsR0FBN0IsRUFBWjs7QUFDQSxRQUFJSCxLQUFKLEVBQ0V6RCxJQUFJLENBQUN3YSxjQUFMLENBQW9CbE0sSUFBcEIsQ0FBeUI3SyxLQUFLLENBQUNJLFVBQU4sRUFBekIsRUFONkMsQ0FPL0M7QUFDQTtBQUNBOztBQUNBLFFBQUk3RCxJQUFJLENBQUN1YSw0QkFBTCxLQUFzQyxDQUExQyxFQUNFdmEsSUFBSSxDQUFDeWEsc0JBQUw7QUFDSCxHQWI0QixDQUEvQjs7QUFlQXphLE1BQUksQ0FBQ3FhLGNBQUwsQ0FBb0IvTCxJQUFwQixDQUF5QixZQUFZO0FBQUV3TSxtQkFBZSxDQUFDbFksSUFBaEI7QUFBeUIsR0FBaEUsRUFuRHdDLENBcUR4QztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FBQ0EsTUFBSTdDLE9BQU8sQ0FBQ3FRLHFCQUFaLEVBQW1DO0FBQ2pDcFEsUUFBSSxDQUFDb1EscUJBQUwsR0FBNkJyUSxPQUFPLENBQUNxUSxxQkFBckM7QUFDRCxHQUZELE1BRU87QUFDTCxRQUFJMkssZUFBZSxHQUNiL2EsSUFBSSxDQUFDZ0ssa0JBQUwsQ0FBd0JqSyxPQUF4QixDQUFnQ2liLGlCQUFoQyxJQUNBaGIsSUFBSSxDQUFDZ0ssa0JBQUwsQ0FBd0JqSyxPQUF4QixDQUFnQ2tiLGdCQURoQyxJQUNvRDtBQUNwRGYsdUJBSE47QUFJQSxRQUFJZ0IsY0FBYyxHQUFHM1osTUFBTSxDQUFDNFosV0FBUCxDQUNuQjlkLENBQUMsQ0FBQ0csSUFBRixDQUFPd0MsSUFBSSxDQUFDeWEsc0JBQVosRUFBb0N6YSxJQUFwQyxDQURtQixFQUN3QithLGVBRHhCLENBQXJCOztBQUVBL2EsUUFBSSxDQUFDcWEsY0FBTCxDQUFvQi9MLElBQXBCLENBQXlCLFlBQVk7QUFDbkMvTSxZQUFNLENBQUM2WixhQUFQLENBQXFCRixjQUFyQjtBQUNELEtBRkQ7QUFHRCxHQXhFdUMsQ0EwRXhDOzs7QUFDQWxiLE1BQUksQ0FBQzJhLGlDQUFMOztBQUVBclksU0FBTyxDQUFDLFlBQUQsQ0FBUCxJQUF5QkEsT0FBTyxDQUFDLFlBQUQsQ0FBUCxDQUFzQnlVLEtBQXRCLENBQTRCQyxtQkFBNUIsQ0FDdkIsZ0JBRHVCLEVBQ0wseUJBREssRUFDc0IsQ0FEdEIsQ0FBekI7QUFFRCxDQS9FRDs7QUFpRkEzWixDQUFDLENBQUNrSSxNQUFGLENBQVNxTCxvQkFBb0IsQ0FBQzlTLFNBQTlCLEVBQXlDO0FBQ3ZDO0FBQ0E2YyxtQ0FBaUMsRUFBRSxZQUFZO0FBQzdDLFFBQUkzYSxJQUFJLEdBQUcsSUFBWDtBQUNBLFFBQUlBLElBQUksQ0FBQ3VhLDRCQUFMLEdBQW9DLENBQXhDLEVBQ0U7QUFDRixNQUFFdmEsSUFBSSxDQUFDdWEsNEJBQVA7O0FBQ0F2YSxRQUFJLENBQUM2YSxVQUFMLENBQWdCdkMsU0FBaEIsQ0FBMEIsWUFBWTtBQUNwQ3RZLFVBQUksQ0FBQ3FiLFVBQUw7QUFDRCxLQUZEO0FBR0QsR0FWc0M7QUFZdkM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBQyxpQkFBZSxFQUFFLFlBQVc7QUFDMUIsUUFBSXRiLElBQUksR0FBRyxJQUFYLENBRDBCLENBRTFCO0FBQ0E7O0FBQ0EsTUFBRUEsSUFBSSxDQUFDdWEsNEJBQVAsQ0FKMEIsQ0FLMUI7O0FBQ0F2YSxRQUFJLENBQUM2YSxVQUFMLENBQWdCOUMsT0FBaEIsQ0FBd0IsWUFBVyxDQUFFLENBQXJDLEVBTjBCLENBUTFCO0FBQ0E7OztBQUNBLFFBQUkvWCxJQUFJLENBQUN1YSw0QkFBTCxLQUFzQyxDQUExQyxFQUNFLE1BQU0sSUFBSTdYLEtBQUosQ0FBVSxxQ0FDQTFDLElBQUksQ0FBQ3VhLDRCQURmLENBQU47QUFFSCxHQWpDc0M7QUFrQ3ZDZ0IsZ0JBQWMsRUFBRSxZQUFXO0FBQ3pCLFFBQUl2YixJQUFJLEdBQUcsSUFBWCxDQUR5QixDQUV6Qjs7QUFDQSxRQUFJQSxJQUFJLENBQUN1YSw0QkFBTCxLQUFzQyxDQUExQyxFQUNFLE1BQU0sSUFBSTdYLEtBQUosQ0FBVSxxQ0FDQTFDLElBQUksQ0FBQ3VhLDRCQURmLENBQU4sQ0FKdUIsQ0FNekI7QUFDQTs7QUFDQXZhLFFBQUksQ0FBQzZhLFVBQUwsQ0FBZ0I5QyxPQUFoQixDQUF3QixZQUFZO0FBQ2xDL1gsVUFBSSxDQUFDcWIsVUFBTDtBQUNELEtBRkQ7QUFHRCxHQTdDc0M7QUErQ3ZDQSxZQUFVLEVBQUUsWUFBWTtBQUN0QixRQUFJcmIsSUFBSSxHQUFHLElBQVg7QUFDQSxNQUFFQSxJQUFJLENBQUN1YSw0QkFBUDtBQUVBLFFBQUl2YSxJQUFJLENBQUMrUyxRQUFULEVBQ0U7QUFFRixRQUFJeUksS0FBSyxHQUFHLEtBQVo7QUFDQSxRQUFJQyxVQUFKO0FBQ0EsUUFBSUMsVUFBVSxHQUFHMWIsSUFBSSxDQUFDc2EsUUFBdEI7O0FBQ0EsUUFBSSxDQUFDb0IsVUFBTCxFQUFpQjtBQUNmRixXQUFLLEdBQUcsSUFBUixDQURlLENBRWY7O0FBQ0FFLGdCQUFVLEdBQUcxYixJQUFJLENBQUNpWCxRQUFMLEdBQWdCLEVBQWhCLEdBQXFCLElBQUlyUyxlQUFlLENBQUNtSSxNQUFwQixFQUFsQztBQUNEOztBQUVEL00sUUFBSSxDQUFDb1EscUJBQUwsSUFBOEJwUSxJQUFJLENBQUNvUSxxQkFBTCxFQUE5QixDQWhCc0IsQ0FrQnRCOztBQUNBLFFBQUl1TCxjQUFjLEdBQUczYixJQUFJLENBQUN3YSxjQUExQjtBQUNBeGEsUUFBSSxDQUFDd2EsY0FBTCxHQUFzQixFQUF0QixDQXBCc0IsQ0FzQnRCOztBQUNBLFFBQUk7QUFDRmlCLGdCQUFVLEdBQUd6YixJQUFJLENBQUNpSyxrQkFBTCxDQUF3QndFLGFBQXhCLENBQXNDek8sSUFBSSxDQUFDaVgsUUFBM0MsQ0FBYjtBQUNELEtBRkQsQ0FFRSxPQUFPdlMsQ0FBUCxFQUFVO0FBQ1YsVUFBSThXLEtBQUssSUFBSSxPQUFPOVcsQ0FBQyxDQUFDa1gsSUFBVCxLQUFtQixRQUFoQyxFQUEwQztBQUN4QztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E1YixZQUFJLENBQUNtWixZQUFMLENBQWtCWixVQUFsQixDQUNFLElBQUk3VixLQUFKLENBQ0UsbUNBQ0VtWixJQUFJLENBQUN0TSxTQUFMLENBQWV2UCxJQUFJLENBQUNnSyxrQkFBcEIsQ0FERixHQUM0QyxJQUQ1QyxHQUNtRHRGLENBQUMsQ0FBQ29YLE9BRnZELENBREY7O0FBSUE7QUFDRCxPQVpTLENBY1Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQUMsV0FBSyxDQUFDamUsU0FBTixDQUFnQndRLElBQWhCLENBQXFCMUYsS0FBckIsQ0FBMkI1SSxJQUFJLENBQUN3YSxjQUFoQyxFQUFnRG1CLGNBQWhEOztBQUNBcGEsWUFBTSxDQUFDa1QsTUFBUCxDQUFjLG1DQUNBb0gsSUFBSSxDQUFDdE0sU0FBTCxDQUFldlAsSUFBSSxDQUFDZ0ssa0JBQXBCLENBRGQsRUFDdUR0RixDQUR2RDs7QUFFQTtBQUNELEtBakRxQixDQW1EdEI7OztBQUNBLFFBQUksQ0FBQzFFLElBQUksQ0FBQytTLFFBQVYsRUFBb0I7QUFDbEJuTyxxQkFBZSxDQUFDb1gsaUJBQWhCLENBQ0VoYyxJQUFJLENBQUNpWCxRQURQLEVBQ2lCeUUsVUFEakIsRUFDNkJELFVBRDdCLEVBQ3lDemIsSUFBSSxDQUFDbVosWUFEOUM7QUFFRCxLQXZEcUIsQ0F5RHRCO0FBQ0E7QUFDQTs7O0FBQ0EsUUFBSXFDLEtBQUosRUFDRXhiLElBQUksQ0FBQ21aLFlBQUwsQ0FBa0JkLEtBQWxCLEdBN0RvQixDQStEdEI7QUFDQTtBQUNBOztBQUNBclksUUFBSSxDQUFDc2EsUUFBTCxHQUFnQm1CLFVBQWhCLENBbEVzQixDQW9FdEI7QUFDQTtBQUNBO0FBQ0E7O0FBQ0F6YixRQUFJLENBQUNtWixZQUFMLENBQWtCVixPQUFsQixDQUEwQixZQUFZO0FBQ3BDcGIsT0FBQyxDQUFDSyxJQUFGLENBQU9pZSxjQUFQLEVBQXVCLFVBQVVNLENBQVYsRUFBYTtBQUNsQ0EsU0FBQyxDQUFDblksU0FBRjtBQUNELE9BRkQ7QUFHRCxLQUpEO0FBS0QsR0E1SHNDO0FBOEh2Q2xCLE1BQUksRUFBRSxZQUFZO0FBQ2hCLFFBQUk1QyxJQUFJLEdBQUcsSUFBWDtBQUNBQSxRQUFJLENBQUMrUyxRQUFMLEdBQWdCLElBQWhCOztBQUNBMVYsS0FBQyxDQUFDSyxJQUFGLENBQU9zQyxJQUFJLENBQUNxYSxjQUFaLEVBQTRCLFVBQVU2QixDQUFWLEVBQWE7QUFBRUEsT0FBQztBQUFLLEtBQWpELEVBSGdCLENBSWhCOzs7QUFDQTdlLEtBQUMsQ0FBQ0ssSUFBRixDQUFPc0MsSUFBSSxDQUFDd2EsY0FBWixFQUE0QixVQUFVeUIsQ0FBVixFQUFhO0FBQ3ZDQSxPQUFDLENBQUNuWSxTQUFGO0FBQ0QsS0FGRDs7QUFHQXhCLFdBQU8sQ0FBQyxZQUFELENBQVAsSUFBeUJBLE9BQU8sQ0FBQyxZQUFELENBQVAsQ0FBc0J5VSxLQUF0QixDQUE0QkMsbUJBQTVCLENBQ3ZCLGdCQUR1QixFQUNMLHlCQURLLEVBQ3NCLENBQUMsQ0FEdkIsQ0FBekI7QUFFRDtBQXhJc0MsQ0FBekMsRTs7Ozs7Ozs7Ozs7QUNwRkEsSUFBSXhhLE1BQU0sR0FBR0MsR0FBRyxDQUFDQyxPQUFKLENBQVksZUFBWixDQUFiOztBQUVBLElBQUl5ZixLQUFLLEdBQUc7QUFDVkMsVUFBUSxFQUFFLFVBREE7QUFFVkMsVUFBUSxFQUFFLFVBRkE7QUFHVkMsUUFBTSxFQUFFO0FBSEUsQ0FBWixDLENBTUE7QUFDQTs7QUFDQSxJQUFJQyxlQUFlLEdBQUcsWUFBWSxDQUFFLENBQXBDOztBQUNBLElBQUlDLHVCQUF1QixHQUFHLFVBQVU5TCxDQUFWLEVBQWE7QUFDekMsU0FBTyxZQUFZO0FBQ2pCLFFBQUk7QUFDRkEsT0FBQyxDQUFDOUgsS0FBRixDQUFRLElBQVIsRUFBY0MsU0FBZDtBQUNELEtBRkQsQ0FFRSxPQUFPbkUsQ0FBUCxFQUFVO0FBQ1YsVUFBSSxFQUFFQSxDQUFDLFlBQVk2WCxlQUFmLENBQUosRUFDRSxNQUFNN1gsQ0FBTjtBQUNIO0FBQ0YsR0FQRDtBQVFELENBVEQ7O0FBV0EsSUFBSStYLFNBQVMsR0FBRyxDQUFoQixDLENBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFDQWxNLGtCQUFrQixHQUFHLFVBQVV4USxPQUFWLEVBQW1CO0FBQ3RDLE1BQUlDLElBQUksR0FBRyxJQUFYO0FBQ0FBLE1BQUksQ0FBQzBjLFVBQUwsR0FBa0IsSUFBbEIsQ0FGc0MsQ0FFYjs7QUFFekIxYyxNQUFJLENBQUMrRSxHQUFMLEdBQVcwWCxTQUFYO0FBQ0FBLFdBQVM7QUFFVHpjLE1BQUksQ0FBQ2dLLGtCQUFMLEdBQTBCakssT0FBTyxDQUFDK0osaUJBQWxDO0FBQ0E5SixNQUFJLENBQUNvYSxZQUFMLEdBQW9CcmEsT0FBTyxDQUFDOFEsV0FBNUI7QUFDQTdRLE1BQUksQ0FBQ21aLFlBQUwsR0FBb0JwWixPQUFPLENBQUN5UCxXQUE1Qjs7QUFFQSxNQUFJelAsT0FBTyxDQUFDb0wsT0FBWixFQUFxQjtBQUNuQixVQUFNekksS0FBSyxDQUFDLDJEQUFELENBQVg7QUFDRDs7QUFFRCxNQUFJdU4sTUFBTSxHQUFHbFEsT0FBTyxDQUFDa1EsTUFBckIsQ0Fmc0MsQ0FnQnRDO0FBQ0E7O0FBQ0EsTUFBSTBNLFVBQVUsR0FBRzFNLE1BQU0sSUFBSUEsTUFBTSxDQUFDMk0sYUFBUCxFQUEzQjs7QUFFQSxNQUFJN2MsT0FBTyxDQUFDK0osaUJBQVIsQ0FBMEIvSixPQUExQixDQUFrQ21KLEtBQXRDLEVBQTZDO0FBQzNDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFFQSxRQUFJMlQsV0FBVyxHQUFHO0FBQUVDLFdBQUssRUFBRWxZLGVBQWUsQ0FBQ21JO0FBQXpCLEtBQWxCO0FBQ0EvTSxRQUFJLENBQUMrYyxNQUFMLEdBQWMvYyxJQUFJLENBQUNnSyxrQkFBTCxDQUF3QmpLLE9BQXhCLENBQWdDbUosS0FBOUM7QUFDQWxKLFFBQUksQ0FBQ2dkLFdBQUwsR0FBbUJMLFVBQW5CO0FBQ0EzYyxRQUFJLENBQUNpZCxPQUFMLEdBQWVoTixNQUFmO0FBQ0FqUSxRQUFJLENBQUNrZCxrQkFBTCxHQUEwQixJQUFJQyxVQUFKLENBQWVSLFVBQWYsRUFBMkJFLFdBQTNCLENBQTFCLENBZDJDLENBZTNDOztBQUNBN2MsUUFBSSxDQUFDb2QsVUFBTCxHQUFrQixJQUFJQyxPQUFKLENBQVlWLFVBQVosRUFBd0JFLFdBQXhCLENBQWxCO0FBQ0QsR0FqQkQsTUFpQk87QUFDTDdjLFFBQUksQ0FBQytjLE1BQUwsR0FBYyxDQUFkO0FBQ0EvYyxRQUFJLENBQUNnZCxXQUFMLEdBQW1CLElBQW5CO0FBQ0FoZCxRQUFJLENBQUNpZCxPQUFMLEdBQWUsSUFBZjtBQUNBamQsUUFBSSxDQUFDa2Qsa0JBQUwsR0FBMEIsSUFBMUI7QUFDQWxkLFFBQUksQ0FBQ29kLFVBQUwsR0FBa0IsSUFBSXhZLGVBQWUsQ0FBQ21JLE1BQXBCLEVBQWxCO0FBQ0QsR0EzQ3FDLENBNkN0QztBQUNBO0FBQ0E7OztBQUNBL00sTUFBSSxDQUFDc2QsbUJBQUwsR0FBMkIsS0FBM0I7QUFFQXRkLE1BQUksQ0FBQytTLFFBQUwsR0FBZ0IsS0FBaEI7QUFDQS9TLE1BQUksQ0FBQ3VkLFlBQUwsR0FBb0IsRUFBcEI7QUFFQWpiLFNBQU8sQ0FBQyxZQUFELENBQVAsSUFBeUJBLE9BQU8sQ0FBQyxZQUFELENBQVAsQ0FBc0J5VSxLQUF0QixDQUE0QkMsbUJBQTVCLENBQ3ZCLGdCQUR1QixFQUNMLHVCQURLLEVBQ29CLENBRHBCLENBQXpCOztBQUdBaFgsTUFBSSxDQUFDd2Qsb0JBQUwsQ0FBMEJyQixLQUFLLENBQUNDLFFBQWhDOztBQUVBcGMsTUFBSSxDQUFDeWQsUUFBTCxHQUFnQjFkLE9BQU8sQ0FBQ2lRLE9BQXhCO0FBQ0EsTUFBSXBFLFVBQVUsR0FBRzVMLElBQUksQ0FBQ2dLLGtCQUFMLENBQXdCakssT0FBeEIsQ0FBZ0M4TCxNQUFoQyxJQUEwQyxFQUEzRDtBQUNBN0wsTUFBSSxDQUFDMGQsYUFBTCxHQUFxQjlZLGVBQWUsQ0FBQytZLGtCQUFoQixDQUFtQy9SLFVBQW5DLENBQXJCLENBNURzQyxDQTZEdEM7QUFDQTs7QUFDQTVMLE1BQUksQ0FBQzRkLGlCQUFMLEdBQXlCNWQsSUFBSSxDQUFDeWQsUUFBTCxDQUFjSSxxQkFBZCxDQUFvQ2pTLFVBQXBDLENBQXpCO0FBQ0EsTUFBSXFFLE1BQUosRUFDRWpRLElBQUksQ0FBQzRkLGlCQUFMLEdBQXlCM04sTUFBTSxDQUFDNE4scUJBQVAsQ0FBNkI3ZCxJQUFJLENBQUM0ZCxpQkFBbEMsQ0FBekI7QUFDRjVkLE1BQUksQ0FBQzhkLG1CQUFMLEdBQTJCbFosZUFBZSxDQUFDK1ksa0JBQWhCLENBQ3pCM2QsSUFBSSxDQUFDNGQsaUJBRG9CLENBQTNCO0FBR0E1ZCxNQUFJLENBQUMrZCxZQUFMLEdBQW9CLElBQUluWixlQUFlLENBQUNtSSxNQUFwQixFQUFwQjtBQUNBL00sTUFBSSxDQUFDZ2Usa0JBQUwsR0FBMEIsSUFBMUI7QUFDQWhlLE1BQUksQ0FBQ2llLGdCQUFMLEdBQXdCLENBQXhCO0FBRUFqZSxNQUFJLENBQUNrZSx5QkFBTCxHQUFpQyxLQUFqQztBQUNBbGUsTUFBSSxDQUFDbWUsZ0NBQUwsR0FBd0MsRUFBeEMsQ0ExRXNDLENBNEV0QztBQUNBOztBQUNBbmUsTUFBSSxDQUFDdWQsWUFBTCxDQUFrQmpQLElBQWxCLENBQXVCdE8sSUFBSSxDQUFDb2EsWUFBTCxDQUFrQmpaLFlBQWxCLENBQStCd1QsZ0JBQS9CLENBQ3JCNkgsdUJBQXVCLENBQUMsWUFBWTtBQUNsQ3hjLFFBQUksQ0FBQ29lLGdCQUFMO0FBQ0QsR0FGc0IsQ0FERixDQUF2Qjs7QUFNQWpOLGdCQUFjLENBQUNuUixJQUFJLENBQUNnSyxrQkFBTixFQUEwQixVQUFVb0gsT0FBVixFQUFtQjtBQUN6RHBSLFFBQUksQ0FBQ3VkLFlBQUwsQ0FBa0JqUCxJQUFsQixDQUF1QnRPLElBQUksQ0FBQ29hLFlBQUwsQ0FBa0JqWixZQUFsQixDQUErQm1ULFlBQS9CLENBQ3JCbEQsT0FEcUIsRUFDWixVQUFVb0QsWUFBVixFQUF3QjtBQUMvQmpULFlBQU0sQ0FBQ29PLGdCQUFQLENBQXdCNk0sdUJBQXVCLENBQUMsWUFBWTtBQUMxRCxZQUFJakssRUFBRSxHQUFHaUMsWUFBWSxDQUFDakMsRUFBdEI7O0FBQ0EsWUFBSWlDLFlBQVksQ0FBQ3hPLGNBQWIsSUFBK0J3TyxZQUFZLENBQUNyTyxZQUFoRCxFQUE4RDtBQUM1RDtBQUNBO0FBQ0E7QUFDQW5HLGNBQUksQ0FBQ29lLGdCQUFMO0FBQ0QsU0FMRCxNQUtPO0FBQ0w7QUFDQSxjQUFJcGUsSUFBSSxDQUFDcWUsTUFBTCxLQUFnQmxDLEtBQUssQ0FBQ0MsUUFBMUIsRUFBb0M7QUFDbENwYyxnQkFBSSxDQUFDc2UseUJBQUwsQ0FBK0IvTCxFQUEvQjtBQUNELFdBRkQsTUFFTztBQUNMdlMsZ0JBQUksQ0FBQ3VlLGlDQUFMLENBQXVDaE0sRUFBdkM7QUFDRDtBQUNGO0FBQ0YsT0FmOEMsQ0FBL0M7QUFnQkQsS0FsQm9CLENBQXZCO0FBb0JELEdBckJhLENBQWQsQ0FwRnNDLENBMkd0Qzs7QUFDQXZTLE1BQUksQ0FBQ3VkLFlBQUwsQ0FBa0JqUCxJQUFsQixDQUF1QjBDLFNBQVMsQ0FDOUJoUixJQUFJLENBQUNnSyxrQkFEeUIsRUFDTCxVQUFVd0ssWUFBVixFQUF3QjtBQUMvQztBQUNBLFFBQUkvUSxLQUFLLEdBQUdDLFNBQVMsQ0FBQ0Msa0JBQVYsQ0FBNkJDLEdBQTdCLEVBQVo7O0FBQ0EsUUFBSSxDQUFDSCxLQUFELElBQVVBLEtBQUssQ0FBQythLEtBQXBCLEVBQ0U7O0FBRUYsUUFBSS9hLEtBQUssQ0FBQ2diLG9CQUFWLEVBQWdDO0FBQzlCaGIsV0FBSyxDQUFDZ2Isb0JBQU4sQ0FBMkJ6ZSxJQUFJLENBQUMrRSxHQUFoQyxJQUF1Qy9FLElBQXZDO0FBQ0E7QUFDRDs7QUFFRHlELFNBQUssQ0FBQ2diLG9CQUFOLEdBQTZCLEVBQTdCO0FBQ0FoYixTQUFLLENBQUNnYixvQkFBTixDQUEyQnplLElBQUksQ0FBQytFLEdBQWhDLElBQXVDL0UsSUFBdkM7QUFFQXlELFNBQUssQ0FBQ2liLFlBQU4sQ0FBbUIsWUFBWTtBQUM3QixVQUFJQyxPQUFPLEdBQUdsYixLQUFLLENBQUNnYixvQkFBcEI7QUFDQSxhQUFPaGIsS0FBSyxDQUFDZ2Isb0JBQWIsQ0FGNkIsQ0FJN0I7QUFDQTs7QUFDQXplLFVBQUksQ0FBQ29hLFlBQUwsQ0FBa0JqWixZQUFsQixDQUErQnlULGlCQUEvQjs7QUFFQXZYLE9BQUMsQ0FBQ0ssSUFBRixDQUFPaWhCLE9BQVAsRUFBZ0IsVUFBVUMsTUFBVixFQUFrQjtBQUNoQyxZQUFJQSxNQUFNLENBQUM3TCxRQUFYLEVBQ0U7QUFFRixZQUFJN08sS0FBSyxHQUFHVCxLQUFLLENBQUNJLFVBQU4sRUFBWjs7QUFDQSxZQUFJK2EsTUFBTSxDQUFDUCxNQUFQLEtBQWtCbEMsS0FBSyxDQUFDRyxNQUE1QixFQUFvQztBQUNsQztBQUNBO0FBQ0E7QUFDQXNDLGdCQUFNLENBQUN6RixZQUFQLENBQW9CVixPQUFwQixDQUE0QixZQUFZO0FBQ3RDdlUsaUJBQUssQ0FBQ0osU0FBTjtBQUNELFdBRkQ7QUFHRCxTQVBELE1BT087QUFDTDhhLGdCQUFNLENBQUNULGdDQUFQLENBQXdDN1AsSUFBeEMsQ0FBNkNwSyxLQUE3QztBQUNEO0FBQ0YsT0FmRDtBQWdCRCxLQXhCRDtBQXlCRCxHQXhDNkIsQ0FBaEMsRUE1R3NDLENBdUp0QztBQUNBOzs7QUFDQWxFLE1BQUksQ0FBQ3VkLFlBQUwsQ0FBa0JqUCxJQUFsQixDQUF1QnRPLElBQUksQ0FBQ29hLFlBQUwsQ0FBa0JyVyxXQUFsQixDQUE4QnlZLHVCQUF1QixDQUMxRSxZQUFZO0FBQ1Z4YyxRQUFJLENBQUNvZSxnQkFBTDtBQUNELEdBSHlFLENBQXJELENBQXZCLEVBekpzQyxDQThKdEM7QUFDQTs7O0FBQ0E3YyxRQUFNLENBQUM2TixLQUFQLENBQWFvTix1QkFBdUIsQ0FBQyxZQUFZO0FBQy9DeGMsUUFBSSxDQUFDNmUsZ0JBQUw7QUFDRCxHQUZtQyxDQUFwQztBQUdELENBbktEOztBQXFLQXhoQixDQUFDLENBQUNrSSxNQUFGLENBQVNnTCxrQkFBa0IsQ0FBQ3pTLFNBQTVCLEVBQXVDO0FBQ3JDZ2hCLGVBQWEsRUFBRSxVQUFVaGEsRUFBVixFQUFjOUMsR0FBZCxFQUFtQjtBQUNoQyxRQUFJaEMsSUFBSSxHQUFHLElBQVg7O0FBQ0F1QixVQUFNLENBQUNvTyxnQkFBUCxDQUF3QixZQUFZO0FBQ2xDLFVBQUk5RCxNQUFNLEdBQUd4TyxDQUFDLENBQUNVLEtBQUYsQ0FBUWlFLEdBQVIsQ0FBYjs7QUFDQSxhQUFPNkosTUFBTSxDQUFDOUcsR0FBZDs7QUFDQS9FLFVBQUksQ0FBQ29kLFVBQUwsQ0FBZ0I5UCxHQUFoQixDQUFvQnhJLEVBQXBCLEVBQXdCOUUsSUFBSSxDQUFDOGQsbUJBQUwsQ0FBeUI5YixHQUF6QixDQUF4Qjs7QUFDQWhDLFVBQUksQ0FBQ21aLFlBQUwsQ0FBa0J6SCxLQUFsQixDQUF3QjVNLEVBQXhCLEVBQTRCOUUsSUFBSSxDQUFDMGQsYUFBTCxDQUFtQjdSLE1BQW5CLENBQTVCLEVBSmtDLENBTWxDO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQSxVQUFJN0wsSUFBSSxDQUFDK2MsTUFBTCxJQUFlL2MsSUFBSSxDQUFDb2QsVUFBTCxDQUFnQnJlLElBQWhCLEtBQXlCaUIsSUFBSSxDQUFDK2MsTUFBakQsRUFBeUQ7QUFDdkQ7QUFDQSxZQUFJL2MsSUFBSSxDQUFDb2QsVUFBTCxDQUFnQnJlLElBQWhCLE9BQTJCaUIsSUFBSSxDQUFDK2MsTUFBTCxHQUFjLENBQTdDLEVBQWdEO0FBQzlDLGdCQUFNLElBQUlyYSxLQUFKLENBQVUsaUNBQ0MxQyxJQUFJLENBQUNvZCxVQUFMLENBQWdCcmUsSUFBaEIsS0FBeUJpQixJQUFJLENBQUMrYyxNQUQvQixJQUVBLG9DQUZWLENBQU47QUFHRDs7QUFFRCxZQUFJZ0MsZ0JBQWdCLEdBQUcvZSxJQUFJLENBQUNvZCxVQUFMLENBQWdCNEIsWUFBaEIsRUFBdkI7O0FBQ0EsWUFBSUMsY0FBYyxHQUFHamYsSUFBSSxDQUFDb2QsVUFBTCxDQUFnQnhaLEdBQWhCLENBQW9CbWIsZ0JBQXBCLENBQXJCOztBQUVBLFlBQUkvZixLQUFLLENBQUNrZ0IsTUFBTixDQUFhSCxnQkFBYixFQUErQmphLEVBQS9CLENBQUosRUFBd0M7QUFDdEMsZ0JBQU0sSUFBSXBDLEtBQUosQ0FBVSwwREFBVixDQUFOO0FBQ0Q7O0FBRUQxQyxZQUFJLENBQUNvZCxVQUFMLENBQWdCdlgsTUFBaEIsQ0FBdUJrWixnQkFBdkI7O0FBQ0EvZSxZQUFJLENBQUNtWixZQUFMLENBQWtCZ0csT0FBbEIsQ0FBMEJKLGdCQUExQjs7QUFDQS9lLFlBQUksQ0FBQ29mLFlBQUwsQ0FBa0JMLGdCQUFsQixFQUFvQ0UsY0FBcEM7QUFDRDtBQUNGLEtBN0JEO0FBOEJELEdBakNvQztBQWtDckNJLGtCQUFnQixFQUFFLFVBQVV2YSxFQUFWLEVBQWM7QUFDOUIsUUFBSTlFLElBQUksR0FBRyxJQUFYOztBQUNBdUIsVUFBTSxDQUFDb08sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQzNQLFVBQUksQ0FBQ29kLFVBQUwsQ0FBZ0J2WCxNQUFoQixDQUF1QmYsRUFBdkI7O0FBQ0E5RSxVQUFJLENBQUNtWixZQUFMLENBQWtCZ0csT0FBbEIsQ0FBMEJyYSxFQUExQjs7QUFDQSxVQUFJLENBQUU5RSxJQUFJLENBQUMrYyxNQUFQLElBQWlCL2MsSUFBSSxDQUFDb2QsVUFBTCxDQUFnQnJlLElBQWhCLE9BQTJCaUIsSUFBSSxDQUFDK2MsTUFBckQsRUFDRTtBQUVGLFVBQUkvYyxJQUFJLENBQUNvZCxVQUFMLENBQWdCcmUsSUFBaEIsS0FBeUJpQixJQUFJLENBQUMrYyxNQUFsQyxFQUNFLE1BQU1yYSxLQUFLLENBQUMsNkJBQUQsQ0FBWCxDQVBnQyxDQVNsQztBQUNBOztBQUVBLFVBQUksQ0FBQzFDLElBQUksQ0FBQ2tkLGtCQUFMLENBQXdCb0MsS0FBeEIsRUFBTCxFQUFzQztBQUNwQztBQUNBO0FBQ0EsWUFBSUMsUUFBUSxHQUFHdmYsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0JzQyxZQUF4QixFQUFmOztBQUNBLFlBQUl2WSxNQUFNLEdBQUdqSCxJQUFJLENBQUNrZCxrQkFBTCxDQUF3QnRaLEdBQXhCLENBQTRCMmIsUUFBNUIsQ0FBYjs7QUFDQXZmLFlBQUksQ0FBQ3lmLGVBQUwsQ0FBcUJGLFFBQXJCOztBQUNBdmYsWUFBSSxDQUFDOGUsYUFBTCxDQUFtQlMsUUFBbkIsRUFBNkJ0WSxNQUE3Qjs7QUFDQTtBQUNELE9BcEJpQyxDQXNCbEM7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQSxVQUFJakgsSUFBSSxDQUFDcWUsTUFBTCxLQUFnQmxDLEtBQUssQ0FBQ0MsUUFBMUIsRUFDRSxPQTlCZ0MsQ0FnQ2xDO0FBQ0E7QUFDQTtBQUNBOztBQUNBLFVBQUlwYyxJQUFJLENBQUNzZCxtQkFBVCxFQUNFLE9BckNnQyxDQXVDbEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBLFlBQU0sSUFBSTVhLEtBQUosQ0FBVSwyQkFBVixDQUFOO0FBQ0QsS0EvQ0Q7QUFnREQsR0FwRm9DO0FBcUZyQ2dkLGtCQUFnQixFQUFFLFVBQVU1YSxFQUFWLEVBQWM2YSxNQUFkLEVBQXNCMVksTUFBdEIsRUFBOEI7QUFDOUMsUUFBSWpILElBQUksR0FBRyxJQUFYOztBQUNBdUIsVUFBTSxDQUFDb08sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQzNQLFVBQUksQ0FBQ29kLFVBQUwsQ0FBZ0I5UCxHQUFoQixDQUFvQnhJLEVBQXBCLEVBQXdCOUUsSUFBSSxDQUFDOGQsbUJBQUwsQ0FBeUI3VyxNQUF6QixDQUF4Qjs7QUFDQSxVQUFJMlksWUFBWSxHQUFHNWYsSUFBSSxDQUFDMGQsYUFBTCxDQUFtQnpXLE1BQW5CLENBQW5COztBQUNBLFVBQUk0WSxZQUFZLEdBQUc3ZixJQUFJLENBQUMwZCxhQUFMLENBQW1CaUMsTUFBbkIsQ0FBbkI7O0FBQ0EsVUFBSUcsT0FBTyxHQUFHQyxZQUFZLENBQUNDLGlCQUFiLENBQ1pKLFlBRFksRUFDRUMsWUFERixDQUFkO0FBRUEsVUFBSSxDQUFDeGlCLENBQUMsQ0FBQ2taLE9BQUYsQ0FBVXVKLE9BQVYsQ0FBTCxFQUNFOWYsSUFBSSxDQUFDbVosWUFBTCxDQUFrQjJHLE9BQWxCLENBQTBCaGIsRUFBMUIsRUFBOEJnYixPQUE5QjtBQUNILEtBUkQ7QUFTRCxHQWhHb0M7QUFpR3JDVixjQUFZLEVBQUUsVUFBVXRhLEVBQVYsRUFBYzlDLEdBQWQsRUFBbUI7QUFDL0IsUUFBSWhDLElBQUksR0FBRyxJQUFYOztBQUNBdUIsVUFBTSxDQUFDb08sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQzNQLFVBQUksQ0FBQ2tkLGtCQUFMLENBQXdCNVAsR0FBeEIsQ0FBNEJ4SSxFQUE1QixFQUFnQzlFLElBQUksQ0FBQzhkLG1CQUFMLENBQXlCOWIsR0FBekIsQ0FBaEMsRUFEa0MsQ0FHbEM7OztBQUNBLFVBQUloQyxJQUFJLENBQUNrZCxrQkFBTCxDQUF3Qm5lLElBQXhCLEtBQWlDaUIsSUFBSSxDQUFDK2MsTUFBMUMsRUFBa0Q7QUFDaEQsWUFBSWtELGFBQWEsR0FBR2pnQixJQUFJLENBQUNrZCxrQkFBTCxDQUF3QjhCLFlBQXhCLEVBQXBCOztBQUVBaGYsWUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0JyWCxNQUF4QixDQUErQm9hLGFBQS9CLEVBSGdELENBS2hEO0FBQ0E7OztBQUNBamdCLFlBQUksQ0FBQ3NkLG1CQUFMLEdBQTJCLEtBQTNCO0FBQ0Q7QUFDRixLQWJEO0FBY0QsR0FqSG9DO0FBa0hyQztBQUNBO0FBQ0FtQyxpQkFBZSxFQUFFLFVBQVUzYSxFQUFWLEVBQWM7QUFDN0IsUUFBSTlFLElBQUksR0FBRyxJQUFYOztBQUNBdUIsVUFBTSxDQUFDb08sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQzNQLFVBQUksQ0FBQ2tkLGtCQUFMLENBQXdCclgsTUFBeEIsQ0FBK0JmLEVBQS9CLEVBRGtDLENBRWxDO0FBQ0E7QUFDQTs7O0FBQ0EsVUFBSSxDQUFFOUUsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0JuZSxJQUF4QixFQUFGLElBQW9DLENBQUVpQixJQUFJLENBQUNzZCxtQkFBL0MsRUFDRXRkLElBQUksQ0FBQ29lLGdCQUFMO0FBQ0gsS0FQRDtBQVFELEdBOUhvQztBQStIckM7QUFDQTtBQUNBO0FBQ0E4QixjQUFZLEVBQUUsVUFBVWxlLEdBQVYsRUFBZTtBQUMzQixRQUFJaEMsSUFBSSxHQUFHLElBQVg7O0FBQ0F1QixVQUFNLENBQUNvTyxnQkFBUCxDQUF3QixZQUFZO0FBQ2xDLFVBQUk3SyxFQUFFLEdBQUc5QyxHQUFHLENBQUMrQyxHQUFiO0FBQ0EsVUFBSS9FLElBQUksQ0FBQ29kLFVBQUwsQ0FBZ0JyYyxHQUFoQixDQUFvQitELEVBQXBCLENBQUosRUFDRSxNQUFNcEMsS0FBSyxDQUFDLDhDQUE4Q29DLEVBQS9DLENBQVg7QUFDRixVQUFJOUUsSUFBSSxDQUFDK2MsTUFBTCxJQUFlL2MsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0JuYyxHQUF4QixDQUE0QitELEVBQTVCLENBQW5CLEVBQ0UsTUFBTXBDLEtBQUssQ0FBQyxzREFBc0RvQyxFQUF2RCxDQUFYO0FBRUYsVUFBSW9FLEtBQUssR0FBR2xKLElBQUksQ0FBQytjLE1BQWpCO0FBQ0EsVUFBSUosVUFBVSxHQUFHM2MsSUFBSSxDQUFDZ2QsV0FBdEI7QUFDQSxVQUFJbUQsWUFBWSxHQUFJalgsS0FBSyxJQUFJbEosSUFBSSxDQUFDb2QsVUFBTCxDQUFnQnJlLElBQWhCLEtBQXlCLENBQW5DLEdBQ2pCaUIsSUFBSSxDQUFDb2QsVUFBTCxDQUFnQnhaLEdBQWhCLENBQW9CNUQsSUFBSSxDQUFDb2QsVUFBTCxDQUFnQjRCLFlBQWhCLEVBQXBCLENBRGlCLEdBQ3FDLElBRHhEO0FBRUEsVUFBSW9CLFdBQVcsR0FBSWxYLEtBQUssSUFBSWxKLElBQUksQ0FBQ2tkLGtCQUFMLENBQXdCbmUsSUFBeEIsS0FBaUMsQ0FBM0MsR0FDZGlCLElBQUksQ0FBQ2tkLGtCQUFMLENBQXdCdFosR0FBeEIsQ0FBNEI1RCxJQUFJLENBQUNrZCxrQkFBTCxDQUF3QjhCLFlBQXhCLEVBQTVCLENBRGMsR0FFZCxJQUZKLENBWGtDLENBY2xDO0FBQ0E7QUFDQTs7QUFDQSxVQUFJcUIsU0FBUyxHQUFHLENBQUVuWCxLQUFGLElBQVdsSixJQUFJLENBQUNvZCxVQUFMLENBQWdCcmUsSUFBaEIsS0FBeUJtSyxLQUFwQyxJQUNkeVQsVUFBVSxDQUFDM2EsR0FBRCxFQUFNbWUsWUFBTixDQUFWLEdBQWdDLENBRGxDLENBakJrQyxDQW9CbEM7QUFDQTtBQUNBOztBQUNBLFVBQUlHLGlCQUFpQixHQUFHLENBQUNELFNBQUQsSUFBY3JnQixJQUFJLENBQUNzZCxtQkFBbkIsSUFDdEJ0ZCxJQUFJLENBQUNrZCxrQkFBTCxDQUF3Qm5lLElBQXhCLEtBQWlDbUssS0FEbkMsQ0F2QmtDLENBMEJsQztBQUNBOztBQUNBLFVBQUlxWCxtQkFBbUIsR0FBRyxDQUFDRixTQUFELElBQWNELFdBQWQsSUFDeEJ6RCxVQUFVLENBQUMzYSxHQUFELEVBQU1vZSxXQUFOLENBQVYsSUFBZ0MsQ0FEbEM7QUFHQSxVQUFJSSxRQUFRLEdBQUdGLGlCQUFpQixJQUFJQyxtQkFBcEM7O0FBRUEsVUFBSUYsU0FBSixFQUFlO0FBQ2JyZ0IsWUFBSSxDQUFDOGUsYUFBTCxDQUFtQmhhLEVBQW5CLEVBQXVCOUMsR0FBdkI7QUFDRCxPQUZELE1BRU8sSUFBSXdlLFFBQUosRUFBYztBQUNuQnhnQixZQUFJLENBQUNvZixZQUFMLENBQWtCdGEsRUFBbEIsRUFBc0I5QyxHQUF0QjtBQUNELE9BRk0sTUFFQTtBQUNMO0FBQ0FoQyxZQUFJLENBQUNzZCxtQkFBTCxHQUEyQixLQUEzQjtBQUNEO0FBQ0YsS0F6Q0Q7QUEwQ0QsR0E5S29DO0FBK0tyQztBQUNBO0FBQ0E7QUFDQW1ELGlCQUFlLEVBQUUsVUFBVTNiLEVBQVYsRUFBYztBQUM3QixRQUFJOUUsSUFBSSxHQUFHLElBQVg7O0FBQ0F1QixVQUFNLENBQUNvTyxnQkFBUCxDQUF3QixZQUFZO0FBQ2xDLFVBQUksQ0FBRTNQLElBQUksQ0FBQ29kLFVBQUwsQ0FBZ0JyYyxHQUFoQixDQUFvQitELEVBQXBCLENBQUYsSUFBNkIsQ0FBRTlFLElBQUksQ0FBQytjLE1BQXhDLEVBQ0UsTUFBTXJhLEtBQUssQ0FBQyx1REFBdURvQyxFQUF4RCxDQUFYOztBQUVGLFVBQUk5RSxJQUFJLENBQUNvZCxVQUFMLENBQWdCcmMsR0FBaEIsQ0FBb0IrRCxFQUFwQixDQUFKLEVBQTZCO0FBQzNCOUUsWUFBSSxDQUFDcWYsZ0JBQUwsQ0FBc0J2YSxFQUF0QjtBQUNELE9BRkQsTUFFTyxJQUFJOUUsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0JuYyxHQUF4QixDQUE0QitELEVBQTVCLENBQUosRUFBcUM7QUFDMUM5RSxZQUFJLENBQUN5ZixlQUFMLENBQXFCM2EsRUFBckI7QUFDRDtBQUNGLEtBVEQ7QUFVRCxHQTlMb0M7QUErTHJDNGIsWUFBVSxFQUFFLFVBQVU1YixFQUFWLEVBQWNtQyxNQUFkLEVBQXNCO0FBQ2hDLFFBQUlqSCxJQUFJLEdBQUcsSUFBWDs7QUFDQXVCLFVBQU0sQ0FBQ29PLGdCQUFQLENBQXdCLFlBQVk7QUFDbEMsVUFBSWdSLFVBQVUsR0FBRzFaLE1BQU0sSUFBSWpILElBQUksQ0FBQ3lkLFFBQUwsQ0FBY21ELGVBQWQsQ0FBOEIzWixNQUE5QixFQUFzQzdDLE1BQWpFOztBQUVBLFVBQUl5YyxlQUFlLEdBQUc3Z0IsSUFBSSxDQUFDb2QsVUFBTCxDQUFnQnJjLEdBQWhCLENBQW9CK0QsRUFBcEIsQ0FBdEI7O0FBQ0EsVUFBSWdjLGNBQWMsR0FBRzlnQixJQUFJLENBQUMrYyxNQUFMLElBQWUvYyxJQUFJLENBQUNrZCxrQkFBTCxDQUF3Qm5jLEdBQXhCLENBQTRCK0QsRUFBNUIsQ0FBcEM7O0FBQ0EsVUFBSWljLFlBQVksR0FBR0YsZUFBZSxJQUFJQyxjQUF0Qzs7QUFFQSxVQUFJSCxVQUFVLElBQUksQ0FBQ0ksWUFBbkIsRUFBaUM7QUFDL0IvZ0IsWUFBSSxDQUFDa2dCLFlBQUwsQ0FBa0JqWixNQUFsQjtBQUNELE9BRkQsTUFFTyxJQUFJOFosWUFBWSxJQUFJLENBQUNKLFVBQXJCLEVBQWlDO0FBQ3RDM2dCLFlBQUksQ0FBQ3lnQixlQUFMLENBQXFCM2IsRUFBckI7QUFDRCxPQUZNLE1BRUEsSUFBSWljLFlBQVksSUFBSUosVUFBcEIsRUFBZ0M7QUFDckMsWUFBSWhCLE1BQU0sR0FBRzNmLElBQUksQ0FBQ29kLFVBQUwsQ0FBZ0J4WixHQUFoQixDQUFvQmtCLEVBQXBCLENBQWI7O0FBQ0EsWUFBSTZYLFVBQVUsR0FBRzNjLElBQUksQ0FBQ2dkLFdBQXRCOztBQUNBLFlBQUlnRSxXQUFXLEdBQUdoaEIsSUFBSSxDQUFDK2MsTUFBTCxJQUFlL2MsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0JuZSxJQUF4QixFQUFmLElBQ2hCaUIsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0J0WixHQUF4QixDQUE0QjVELElBQUksQ0FBQ2tkLGtCQUFMLENBQXdCc0MsWUFBeEIsRUFBNUIsQ0FERjs7QUFFQSxZQUFJWSxXQUFKOztBQUVBLFlBQUlTLGVBQUosRUFBcUI7QUFDbkI7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsY0FBSUksZ0JBQWdCLEdBQUcsQ0FBRWpoQixJQUFJLENBQUMrYyxNQUFQLElBQ3JCL2MsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0JuZSxJQUF4QixPQUFtQyxDQURkLElBRXJCNGQsVUFBVSxDQUFDMVYsTUFBRCxFQUFTK1osV0FBVCxDQUFWLElBQW1DLENBRnJDOztBQUlBLGNBQUlDLGdCQUFKLEVBQXNCO0FBQ3BCamhCLGdCQUFJLENBQUMwZixnQkFBTCxDQUFzQjVhLEVBQXRCLEVBQTBCNmEsTUFBMUIsRUFBa0MxWSxNQUFsQztBQUNELFdBRkQsTUFFTztBQUNMO0FBQ0FqSCxnQkFBSSxDQUFDcWYsZ0JBQUwsQ0FBc0J2YSxFQUF0QixFQUZLLENBR0w7OztBQUNBc2IsdUJBQVcsR0FBR3BnQixJQUFJLENBQUNrZCxrQkFBTCxDQUF3QnRaLEdBQXhCLENBQ1o1RCxJQUFJLENBQUNrZCxrQkFBTCxDQUF3QjhCLFlBQXhCLEVBRFksQ0FBZDtBQUdBLGdCQUFJd0IsUUFBUSxHQUFHeGdCLElBQUksQ0FBQ3NkLG1CQUFMLElBQ1I4QyxXQUFXLElBQUl6RCxVQUFVLENBQUMxVixNQUFELEVBQVNtWixXQUFULENBQVYsSUFBbUMsQ0FEekQ7O0FBR0EsZ0JBQUlJLFFBQUosRUFBYztBQUNaeGdCLGtCQUFJLENBQUNvZixZQUFMLENBQWtCdGEsRUFBbEIsRUFBc0JtQyxNQUF0QjtBQUNELGFBRkQsTUFFTztBQUNMO0FBQ0FqSCxrQkFBSSxDQUFDc2QsbUJBQUwsR0FBMkIsS0FBM0I7QUFDRDtBQUNGO0FBQ0YsU0FqQ0QsTUFpQ08sSUFBSXdELGNBQUosRUFBb0I7QUFDekJuQixnQkFBTSxHQUFHM2YsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0J0WixHQUF4QixDQUE0QmtCLEVBQTVCLENBQVQsQ0FEeUIsQ0FFekI7QUFDQTtBQUNBO0FBQ0E7O0FBQ0E5RSxjQUFJLENBQUNrZCxrQkFBTCxDQUF3QnJYLE1BQXhCLENBQStCZixFQUEvQjs7QUFFQSxjQUFJcWIsWUFBWSxHQUFHbmdCLElBQUksQ0FBQ29kLFVBQUwsQ0FBZ0J4WixHQUFoQixDQUNqQjVELElBQUksQ0FBQ29kLFVBQUwsQ0FBZ0I0QixZQUFoQixFQURpQixDQUFuQjs7QUFFQW9CLHFCQUFXLEdBQUdwZ0IsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0JuZSxJQUF4QixNQUNSaUIsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0J0WixHQUF4QixDQUNFNUQsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0I4QixZQUF4QixFQURGLENBRE4sQ0FWeUIsQ0FjekI7O0FBQ0EsY0FBSXFCLFNBQVMsR0FBRzFELFVBQVUsQ0FBQzFWLE1BQUQsRUFBU2taLFlBQVQsQ0FBVixHQUFtQyxDQUFuRCxDQWZ5QixDQWlCekI7O0FBQ0EsY0FBSWUsYUFBYSxHQUFJLENBQUViLFNBQUYsSUFBZXJnQixJQUFJLENBQUNzZCxtQkFBckIsSUFDYixDQUFDK0MsU0FBRCxJQUFjRCxXQUFkLElBQ0F6RCxVQUFVLENBQUMxVixNQUFELEVBQVNtWixXQUFULENBQVYsSUFBbUMsQ0FGMUM7O0FBSUEsY0FBSUMsU0FBSixFQUFlO0FBQ2JyZ0IsZ0JBQUksQ0FBQzhlLGFBQUwsQ0FBbUJoYSxFQUFuQixFQUF1Qm1DLE1BQXZCO0FBQ0QsV0FGRCxNQUVPLElBQUlpYSxhQUFKLEVBQW1CO0FBQ3hCO0FBQ0FsaEIsZ0JBQUksQ0FBQ2tkLGtCQUFMLENBQXdCNVAsR0FBeEIsQ0FBNEJ4SSxFQUE1QixFQUFnQ21DLE1BQWhDO0FBQ0QsV0FITSxNQUdBO0FBQ0w7QUFDQWpILGdCQUFJLENBQUNzZCxtQkFBTCxHQUEyQixLQUEzQixDQUZLLENBR0w7QUFDQTs7QUFDQSxnQkFBSSxDQUFFdGQsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0JuZSxJQUF4QixFQUFOLEVBQXNDO0FBQ3BDaUIsa0JBQUksQ0FBQ29lLGdCQUFMO0FBQ0Q7QUFDRjtBQUNGLFNBcENNLE1Bb0NBO0FBQ0wsZ0JBQU0sSUFBSTFiLEtBQUosQ0FBVSwyRUFBVixDQUFOO0FBQ0Q7QUFDRjtBQUNGLEtBM0ZEO0FBNEZELEdBN1JvQztBQThSckN5ZSx5QkFBdUIsRUFBRSxZQUFZO0FBQ25DLFFBQUluaEIsSUFBSSxHQUFHLElBQVg7O0FBQ0F1QixVQUFNLENBQUNvTyxnQkFBUCxDQUF3QixZQUFZO0FBQ2xDM1AsVUFBSSxDQUFDd2Qsb0JBQUwsQ0FBMEJyQixLQUFLLENBQUNFLFFBQWhDLEVBRGtDLENBRWxDO0FBQ0E7OztBQUNBOWEsWUFBTSxDQUFDNk4sS0FBUCxDQUFhb04sdUJBQXVCLENBQUMsWUFBWTtBQUMvQyxlQUFPLENBQUN4YyxJQUFJLENBQUMrUyxRQUFOLElBQWtCLENBQUMvUyxJQUFJLENBQUMrZCxZQUFMLENBQWtCdUIsS0FBbEIsRUFBMUIsRUFBcUQ7QUFDbkQsY0FBSXRmLElBQUksQ0FBQ3FlLE1BQUwsS0FBZ0JsQyxLQUFLLENBQUNDLFFBQTFCLEVBQW9DO0FBQ2xDO0FBQ0E7QUFDQTtBQUNBO0FBQ0QsV0FOa0QsQ0FRbkQ7OztBQUNBLGNBQUlwYyxJQUFJLENBQUNxZSxNQUFMLEtBQWdCbEMsS0FBSyxDQUFDRSxRQUExQixFQUNFLE1BQU0sSUFBSTNaLEtBQUosQ0FBVSxzQ0FBc0MxQyxJQUFJLENBQUNxZSxNQUFyRCxDQUFOO0FBRUZyZSxjQUFJLENBQUNnZSxrQkFBTCxHQUEwQmhlLElBQUksQ0FBQytkLFlBQS9CO0FBQ0EsY0FBSXFELGNBQWMsR0FBRyxFQUFFcGhCLElBQUksQ0FBQ2llLGdCQUE1QjtBQUNBamUsY0FBSSxDQUFDK2QsWUFBTCxHQUFvQixJQUFJblosZUFBZSxDQUFDbUksTUFBcEIsRUFBcEI7QUFDQSxjQUFJc1UsT0FBTyxHQUFHLENBQWQ7QUFDQSxjQUFJQyxHQUFHLEdBQUcsSUFBSTlrQixNQUFKLEVBQVYsQ0FoQm1ELENBaUJuRDtBQUNBOztBQUNBd0QsY0FBSSxDQUFDZ2Usa0JBQUwsQ0FBd0IxUyxPQUF4QixDQUFnQyxVQUFVaUgsRUFBVixFQUFjek4sRUFBZCxFQUFrQjtBQUNoRHVjLG1CQUFPOztBQUNQcmhCLGdCQUFJLENBQUNvYSxZQUFMLENBQWtCaFosV0FBbEIsQ0FBOEIrSCxLQUE5QixDQUNFbkosSUFBSSxDQUFDZ0ssa0JBQUwsQ0FBd0JqSCxjQUQxQixFQUMwQytCLEVBRDFDLEVBQzhDeU4sRUFEOUMsRUFFRWlLLHVCQUF1QixDQUFDLFVBQVUvYSxHQUFWLEVBQWVPLEdBQWYsRUFBb0I7QUFDMUMsa0JBQUk7QUFDRixvQkFBSVAsR0FBSixFQUFTO0FBQ1BGLHdCQUFNLENBQUNrVCxNQUFQLENBQWMsd0NBQWQsRUFDY2hULEdBRGQsRUFETyxDQUdQO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQSxzQkFBSXpCLElBQUksQ0FBQ3FlLE1BQUwsS0FBZ0JsQyxLQUFLLENBQUNDLFFBQTFCLEVBQW9DO0FBQ2xDcGMsd0JBQUksQ0FBQ29lLGdCQUFMO0FBQ0Q7QUFDRixpQkFWRCxNQVVPLElBQUksQ0FBQ3BlLElBQUksQ0FBQytTLFFBQU4sSUFBa0IvUyxJQUFJLENBQUNxZSxNQUFMLEtBQWdCbEMsS0FBSyxDQUFDRSxRQUF4QyxJQUNHcmMsSUFBSSxDQUFDaWUsZ0JBQUwsS0FBMEJtRCxjQURqQyxFQUNpRDtBQUN0RDtBQUNBO0FBQ0E7QUFDQTtBQUNBcGhCLHNCQUFJLENBQUMwZ0IsVUFBTCxDQUFnQjViLEVBQWhCLEVBQW9COUMsR0FBcEI7QUFDRDtBQUNGLGVBbkJELFNBbUJVO0FBQ1JxZix1QkFBTyxHQURDLENBRVI7QUFDQTtBQUNBOztBQUNBLG9CQUFJQSxPQUFPLEtBQUssQ0FBaEIsRUFDRUMsR0FBRyxDQUFDeEwsTUFBSjtBQUNIO0FBQ0YsYUE1QnNCLENBRnpCO0FBK0JELFdBakNEOztBQWtDQXdMLGFBQUcsQ0FBQ2xmLElBQUosR0FyRG1ELENBc0RuRDs7QUFDQSxjQUFJcEMsSUFBSSxDQUFDcWUsTUFBTCxLQUFnQmxDLEtBQUssQ0FBQ0MsUUFBMUIsRUFDRTtBQUNGcGMsY0FBSSxDQUFDZ2Usa0JBQUwsR0FBMEIsSUFBMUI7QUFDRCxTQTNEOEMsQ0E0RC9DO0FBQ0E7OztBQUNBLFlBQUloZSxJQUFJLENBQUNxZSxNQUFMLEtBQWdCbEMsS0FBSyxDQUFDQyxRQUExQixFQUNFcGMsSUFBSSxDQUFDdWhCLFNBQUw7QUFDSCxPQWhFbUMsQ0FBcEM7QUFpRUQsS0FyRUQ7QUFzRUQsR0F0V29DO0FBdVdyQ0EsV0FBUyxFQUFFLFlBQVk7QUFDckIsUUFBSXZoQixJQUFJLEdBQUcsSUFBWDs7QUFDQXVCLFVBQU0sQ0FBQ29PLGdCQUFQLENBQXdCLFlBQVk7QUFDbEMzUCxVQUFJLENBQUN3ZCxvQkFBTCxDQUEwQnJCLEtBQUssQ0FBQ0csTUFBaEM7O0FBQ0EsVUFBSWtGLE1BQU0sR0FBR3hoQixJQUFJLENBQUNtZSxnQ0FBbEI7QUFDQW5lLFVBQUksQ0FBQ21lLGdDQUFMLEdBQXdDLEVBQXhDOztBQUNBbmUsVUFBSSxDQUFDbVosWUFBTCxDQUFrQlYsT0FBbEIsQ0FBMEIsWUFBWTtBQUNwQ3BiLFNBQUMsQ0FBQ0ssSUFBRixDQUFPOGpCLE1BQVAsRUFBZSxVQUFVdkYsQ0FBVixFQUFhO0FBQzFCQSxXQUFDLENBQUNuWSxTQUFGO0FBQ0QsU0FGRDtBQUdELE9BSkQ7QUFLRCxLQVREO0FBVUQsR0FuWG9DO0FBb1hyQ3dhLDJCQUF5QixFQUFFLFVBQVUvTCxFQUFWLEVBQWM7QUFDdkMsUUFBSXZTLElBQUksR0FBRyxJQUFYOztBQUNBdUIsVUFBTSxDQUFDb08sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQzNQLFVBQUksQ0FBQytkLFlBQUwsQ0FBa0J6USxHQUFsQixDQUFzQmdGLE9BQU8sQ0FBQ0MsRUFBRCxDQUE3QixFQUFtQ0EsRUFBbkM7QUFDRCxLQUZEO0FBR0QsR0F6WG9DO0FBMFhyQ2dNLG1DQUFpQyxFQUFFLFVBQVVoTSxFQUFWLEVBQWM7QUFDL0MsUUFBSXZTLElBQUksR0FBRyxJQUFYOztBQUNBdUIsVUFBTSxDQUFDb08sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQyxVQUFJN0ssRUFBRSxHQUFHd04sT0FBTyxDQUFDQyxFQUFELENBQWhCLENBRGtDLENBRWxDO0FBQ0E7O0FBQ0EsVUFBSXZTLElBQUksQ0FBQ3FlLE1BQUwsS0FBZ0JsQyxLQUFLLENBQUNFLFFBQXRCLEtBQ0VyYyxJQUFJLENBQUNnZSxrQkFBTCxJQUEyQmhlLElBQUksQ0FBQ2dlLGtCQUFMLENBQXdCamQsR0FBeEIsQ0FBNEIrRCxFQUE1QixDQUE1QixJQUNBOUUsSUFBSSxDQUFDK2QsWUFBTCxDQUFrQmhkLEdBQWxCLENBQXNCK0QsRUFBdEIsQ0FGRCxDQUFKLEVBRWlDO0FBQy9COUUsWUFBSSxDQUFDK2QsWUFBTCxDQUFrQnpRLEdBQWxCLENBQXNCeEksRUFBdEIsRUFBMEJ5TixFQUExQjs7QUFDQTtBQUNEOztBQUVELFVBQUlBLEVBQUUsQ0FBQ0EsRUFBSCxLQUFVLEdBQWQsRUFBbUI7QUFDakIsWUFBSXZTLElBQUksQ0FBQ29kLFVBQUwsQ0FBZ0JyYyxHQUFoQixDQUFvQitELEVBQXBCLEtBQ0M5RSxJQUFJLENBQUMrYyxNQUFMLElBQWUvYyxJQUFJLENBQUNrZCxrQkFBTCxDQUF3Qm5jLEdBQXhCLENBQTRCK0QsRUFBNUIsQ0FEcEIsRUFFRTlFLElBQUksQ0FBQ3lnQixlQUFMLENBQXFCM2IsRUFBckI7QUFDSCxPQUpELE1BSU8sSUFBSXlOLEVBQUUsQ0FBQ0EsRUFBSCxLQUFVLEdBQWQsRUFBbUI7QUFDeEIsWUFBSXZTLElBQUksQ0FBQ29kLFVBQUwsQ0FBZ0JyYyxHQUFoQixDQUFvQitELEVBQXBCLENBQUosRUFDRSxNQUFNLElBQUlwQyxLQUFKLENBQVUsbURBQVYsQ0FBTjtBQUNGLFlBQUkxQyxJQUFJLENBQUNrZCxrQkFBTCxJQUEyQmxkLElBQUksQ0FBQ2tkLGtCQUFMLENBQXdCbmMsR0FBeEIsQ0FBNEIrRCxFQUE1QixDQUEvQixFQUNFLE1BQU0sSUFBSXBDLEtBQUosQ0FBVSxnREFBVixDQUFOLENBSnNCLENBTXhCO0FBQ0E7O0FBQ0EsWUFBSTFDLElBQUksQ0FBQ3lkLFFBQUwsQ0FBY21ELGVBQWQsQ0FBOEJyTyxFQUFFLENBQUNDLENBQWpDLEVBQW9DcE8sTUFBeEMsRUFDRXBFLElBQUksQ0FBQ2tnQixZQUFMLENBQWtCM04sRUFBRSxDQUFDQyxDQUFyQjtBQUNILE9BVk0sTUFVQSxJQUFJRCxFQUFFLENBQUNBLEVBQUgsS0FBVSxHQUFkLEVBQW1CO0FBQ3hCO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsWUFBSWtQLFNBQVMsR0FBRyxDQUFDcGtCLENBQUMsQ0FBQzBELEdBQUYsQ0FBTXdSLEVBQUUsQ0FBQ0MsQ0FBVCxFQUFZLE1BQVosQ0FBRCxJQUF3QixDQUFDblYsQ0FBQyxDQUFDMEQsR0FBRixDQUFNd1IsRUFBRSxDQUFDQyxDQUFULEVBQVksUUFBWixDQUF6QyxDQUx3QixDQU14QjtBQUNBO0FBQ0E7QUFDQTs7QUFDQSxZQUFJa1Asb0JBQW9CLEdBQ3RCLENBQUNELFNBQUQsSUFBY0UsNEJBQTRCLENBQUNwUCxFQUFFLENBQUNDLENBQUosQ0FENUM7O0FBR0EsWUFBSXFPLGVBQWUsR0FBRzdnQixJQUFJLENBQUNvZCxVQUFMLENBQWdCcmMsR0FBaEIsQ0FBb0IrRCxFQUFwQixDQUF0Qjs7QUFDQSxZQUFJZ2MsY0FBYyxHQUFHOWdCLElBQUksQ0FBQytjLE1BQUwsSUFBZS9jLElBQUksQ0FBQ2tkLGtCQUFMLENBQXdCbmMsR0FBeEIsQ0FBNEIrRCxFQUE1QixDQUFwQzs7QUFFQSxZQUFJMmMsU0FBSixFQUFlO0FBQ2J6aEIsY0FBSSxDQUFDMGdCLFVBQUwsQ0FBZ0I1YixFQUFoQixFQUFvQnpILENBQUMsQ0FBQ2tJLE1BQUYsQ0FBUztBQUFDUixlQUFHLEVBQUVEO0FBQU4sV0FBVCxFQUFvQnlOLEVBQUUsQ0FBQ0MsQ0FBdkIsQ0FBcEI7QUFDRCxTQUZELE1BRU8sSUFBSSxDQUFDcU8sZUFBZSxJQUFJQyxjQUFwQixLQUNBWSxvQkFESixFQUMwQjtBQUMvQjtBQUNBO0FBQ0EsY0FBSXphLE1BQU0sR0FBR2pILElBQUksQ0FBQ29kLFVBQUwsQ0FBZ0JyYyxHQUFoQixDQUFvQitELEVBQXBCLElBQ1Q5RSxJQUFJLENBQUNvZCxVQUFMLENBQWdCeFosR0FBaEIsQ0FBb0JrQixFQUFwQixDQURTLEdBQ2lCOUUsSUFBSSxDQUFDa2Qsa0JBQUwsQ0FBd0J0WixHQUF4QixDQUE0QmtCLEVBQTVCLENBRDlCO0FBRUFtQyxnQkFBTSxHQUFHakksS0FBSyxDQUFDakIsS0FBTixDQUFZa0osTUFBWixDQUFUO0FBRUFBLGdCQUFNLENBQUNsQyxHQUFQLEdBQWFELEVBQWI7O0FBQ0EsY0FBSTtBQUNGRiwyQkFBZSxDQUFDZ2QsT0FBaEIsQ0FBd0IzYSxNQUF4QixFQUFnQ3NMLEVBQUUsQ0FBQ0MsQ0FBbkM7QUFDRCxXQUZELENBRUUsT0FBTzlOLENBQVAsRUFBVTtBQUNWLGdCQUFJQSxDQUFDLENBQUN6RyxJQUFGLEtBQVcsZ0JBQWYsRUFDRSxNQUFNeUcsQ0FBTixDQUZRLENBR1Y7O0FBQ0ExRSxnQkFBSSxDQUFDK2QsWUFBTCxDQUFrQnpRLEdBQWxCLENBQXNCeEksRUFBdEIsRUFBMEJ5TixFQUExQjs7QUFDQSxnQkFBSXZTLElBQUksQ0FBQ3FlLE1BQUwsS0FBZ0JsQyxLQUFLLENBQUNHLE1BQTFCLEVBQWtDO0FBQ2hDdGMsa0JBQUksQ0FBQ21oQix1QkFBTDtBQUNEOztBQUNEO0FBQ0Q7O0FBQ0RuaEIsY0FBSSxDQUFDMGdCLFVBQUwsQ0FBZ0I1YixFQUFoQixFQUFvQjlFLElBQUksQ0FBQzhkLG1CQUFMLENBQXlCN1csTUFBekIsQ0FBcEI7QUFDRCxTQXRCTSxNQXNCQSxJQUFJLENBQUN5YSxvQkFBRCxJQUNBMWhCLElBQUksQ0FBQ3lkLFFBQUwsQ0FBY29FLHVCQUFkLENBQXNDdFAsRUFBRSxDQUFDQyxDQUF6QyxDQURBLElBRUN4UyxJQUFJLENBQUNpZCxPQUFMLElBQWdCamQsSUFBSSxDQUFDaWQsT0FBTCxDQUFhNkUsa0JBQWIsQ0FBZ0N2UCxFQUFFLENBQUNDLENBQW5DLENBRnJCLEVBRTZEO0FBQ2xFeFMsY0FBSSxDQUFDK2QsWUFBTCxDQUFrQnpRLEdBQWxCLENBQXNCeEksRUFBdEIsRUFBMEJ5TixFQUExQjs7QUFDQSxjQUFJdlMsSUFBSSxDQUFDcWUsTUFBTCxLQUFnQmxDLEtBQUssQ0FBQ0csTUFBMUIsRUFDRXRjLElBQUksQ0FBQ21oQix1QkFBTDtBQUNIO0FBQ0YsT0EvQ00sTUErQ0E7QUFDTCxjQUFNemUsS0FBSyxDQUFDLCtCQUErQjZQLEVBQWhDLENBQVg7QUFDRDtBQUNGLEtBM0VEO0FBNEVELEdBeGNvQztBQXljckM7QUFDQXNNLGtCQUFnQixFQUFFLFlBQVk7QUFDNUIsUUFBSTdlLElBQUksR0FBRyxJQUFYO0FBQ0EsUUFBSUEsSUFBSSxDQUFDK1MsUUFBVCxFQUNFLE1BQU0sSUFBSXJRLEtBQUosQ0FBVSxrQ0FBVixDQUFOOztBQUVGMUMsUUFBSSxDQUFDK2hCLFNBQUwsQ0FBZTtBQUFDQyxhQUFPLEVBQUU7QUFBVixLQUFmLEVBTDRCLENBS007OztBQUVsQyxRQUFJaGlCLElBQUksQ0FBQytTLFFBQVQsRUFDRSxPQVIwQixDQVFqQjtBQUVYO0FBQ0E7O0FBQ0EvUyxRQUFJLENBQUNtWixZQUFMLENBQWtCZCxLQUFsQjs7QUFFQXJZLFFBQUksQ0FBQ2lpQixhQUFMLEdBZDRCLENBY0w7O0FBQ3hCLEdBemRvQztBQTJkckM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBQyxZQUFVLEVBQUUsWUFBWTtBQUN0QixRQUFJbGlCLElBQUksR0FBRyxJQUFYOztBQUNBdUIsVUFBTSxDQUFDb08sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQyxVQUFJM1AsSUFBSSxDQUFDK1MsUUFBVCxFQUNFLE9BRmdDLENBSWxDOztBQUNBL1MsVUFBSSxDQUFDK2QsWUFBTCxHQUFvQixJQUFJblosZUFBZSxDQUFDbUksTUFBcEIsRUFBcEI7QUFDQS9NLFVBQUksQ0FBQ2dlLGtCQUFMLEdBQTBCLElBQTFCO0FBQ0EsUUFBRWhlLElBQUksQ0FBQ2llLGdCQUFQLENBUGtDLENBT1I7O0FBQzFCamUsVUFBSSxDQUFDd2Qsb0JBQUwsQ0FBMEJyQixLQUFLLENBQUNDLFFBQWhDLEVBUmtDLENBVWxDO0FBQ0E7OztBQUNBN2EsWUFBTSxDQUFDNk4sS0FBUCxDQUFhLFlBQVk7QUFDdkJwUCxZQUFJLENBQUMraEIsU0FBTDs7QUFDQS9oQixZQUFJLENBQUNpaUIsYUFBTDtBQUNELE9BSEQ7QUFJRCxLQWhCRDtBQWlCRCxHQTVmb0M7QUE4ZnJDO0FBQ0FGLFdBQVMsRUFBRSxVQUFVaGlCLE9BQVYsRUFBbUI7QUFDNUIsUUFBSUMsSUFBSSxHQUFHLElBQVg7QUFDQUQsV0FBTyxHQUFHQSxPQUFPLElBQUksRUFBckI7QUFDQSxRQUFJMGIsVUFBSixFQUFnQjBHLFNBQWhCLENBSDRCLENBSzVCOztBQUNBLFdBQU8sSUFBUCxFQUFhO0FBQ1g7QUFDQSxVQUFJbmlCLElBQUksQ0FBQytTLFFBQVQsRUFDRTtBQUVGMEksZ0JBQVUsR0FBRyxJQUFJN1csZUFBZSxDQUFDbUksTUFBcEIsRUFBYjtBQUNBb1YsZUFBUyxHQUFHLElBQUl2ZCxlQUFlLENBQUNtSSxNQUFwQixFQUFaLENBTlcsQ0FRWDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFDQSxVQUFJK0IsTUFBTSxHQUFHOU8sSUFBSSxDQUFDb2lCLGVBQUwsQ0FBcUI7QUFBRWxaLGFBQUssRUFBRWxKLElBQUksQ0FBQytjLE1BQUwsR0FBYztBQUF2QixPQUFyQixDQUFiOztBQUNBLFVBQUk7QUFDRmpPLGNBQU0sQ0FBQ3hELE9BQVAsQ0FBZSxVQUFVdEosR0FBVixFQUFlcWdCLENBQWYsRUFBa0I7QUFBRztBQUNsQyxjQUFJLENBQUNyaUIsSUFBSSxDQUFDK2MsTUFBTixJQUFnQnNGLENBQUMsR0FBR3JpQixJQUFJLENBQUMrYyxNQUE3QixFQUFxQztBQUNuQ3RCLHNCQUFVLENBQUNuTyxHQUFYLENBQWV0TCxHQUFHLENBQUMrQyxHQUFuQixFQUF3Qi9DLEdBQXhCO0FBQ0QsV0FGRCxNQUVPO0FBQ0xtZ0IscUJBQVMsQ0FBQzdVLEdBQVYsQ0FBY3RMLEdBQUcsQ0FBQytDLEdBQWxCLEVBQXVCL0MsR0FBdkI7QUFDRDtBQUNGLFNBTkQ7QUFPQTtBQUNELE9BVEQsQ0FTRSxPQUFPMEMsQ0FBUCxFQUFVO0FBQ1YsWUFBSTNFLE9BQU8sQ0FBQ2lpQixPQUFSLElBQW1CLE9BQU90ZCxDQUFDLENBQUNrWCxJQUFULEtBQW1CLFFBQTFDLEVBQW9EO0FBQ2xEO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTViLGNBQUksQ0FBQ21aLFlBQUwsQ0FBa0JaLFVBQWxCLENBQTZCN1QsQ0FBN0I7O0FBQ0E7QUFDRCxTQVRTLENBV1Y7QUFDQTs7O0FBQ0FuRCxjQUFNLENBQUNrVCxNQUFQLENBQWMsbUNBQWQsRUFBbUQvUCxDQUFuRDs7QUFDQW5ELGNBQU0sQ0FBQ3dULFdBQVAsQ0FBbUIsR0FBbkI7QUFDRDtBQUNGOztBQUVELFFBQUkvVSxJQUFJLENBQUMrUyxRQUFULEVBQ0U7O0FBRUYvUyxRQUFJLENBQUNzaUIsa0JBQUwsQ0FBd0I3RyxVQUF4QixFQUFvQzBHLFNBQXBDO0FBQ0QsR0FwakJvQztBQXNqQnJDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBL0Qsa0JBQWdCLEVBQUUsWUFBWTtBQUM1QixRQUFJcGUsSUFBSSxHQUFHLElBQVg7O0FBQ0F1QixVQUFNLENBQUNvTyxnQkFBUCxDQUF3QixZQUFZO0FBQ2xDLFVBQUkzUCxJQUFJLENBQUMrUyxRQUFULEVBQ0UsT0FGZ0MsQ0FJbEM7QUFDQTs7QUFDQSxVQUFJL1MsSUFBSSxDQUFDcWUsTUFBTCxLQUFnQmxDLEtBQUssQ0FBQ0MsUUFBMUIsRUFBb0M7QUFDbENwYyxZQUFJLENBQUNraUIsVUFBTDs7QUFDQSxjQUFNLElBQUkzRixlQUFKLEVBQU47QUFDRCxPQVRpQyxDQVdsQztBQUNBOzs7QUFDQXZjLFVBQUksQ0FBQ2tlLHlCQUFMLEdBQWlDLElBQWpDO0FBQ0QsS0FkRDtBQWVELEdBbmxCb0M7QUFxbEJyQztBQUNBK0QsZUFBYSxFQUFFLFlBQVk7QUFDekIsUUFBSWppQixJQUFJLEdBQUcsSUFBWDtBQUVBLFFBQUlBLElBQUksQ0FBQytTLFFBQVQsRUFDRTs7QUFDRi9TLFFBQUksQ0FBQ29hLFlBQUwsQ0FBa0JqWixZQUFsQixDQUErQnlULGlCQUEvQixHQUx5QixDQUs0Qjs7O0FBQ3JELFFBQUk1VSxJQUFJLENBQUMrUyxRQUFULEVBQ0U7QUFDRixRQUFJL1MsSUFBSSxDQUFDcWUsTUFBTCxLQUFnQmxDLEtBQUssQ0FBQ0MsUUFBMUIsRUFDRSxNQUFNMVosS0FBSyxDQUFDLHdCQUF3QjFDLElBQUksQ0FBQ3FlLE1BQTlCLENBQVg7O0FBRUY5YyxVQUFNLENBQUNvTyxnQkFBUCxDQUF3QixZQUFZO0FBQ2xDLFVBQUkzUCxJQUFJLENBQUNrZSx5QkFBVCxFQUFvQztBQUNsQ2xlLFlBQUksQ0FBQ2tlLHlCQUFMLEdBQWlDLEtBQWpDOztBQUNBbGUsWUFBSSxDQUFDa2lCLFVBQUw7QUFDRCxPQUhELE1BR08sSUFBSWxpQixJQUFJLENBQUMrZCxZQUFMLENBQWtCdUIsS0FBbEIsRUFBSixFQUErQjtBQUNwQ3RmLFlBQUksQ0FBQ3VoQixTQUFMO0FBQ0QsT0FGTSxNQUVBO0FBQ0x2aEIsWUFBSSxDQUFDbWhCLHVCQUFMO0FBQ0Q7QUFDRixLQVREO0FBVUQsR0EzbUJvQztBQTZtQnJDaUIsaUJBQWUsRUFBRSxVQUFVRyxnQkFBVixFQUE0QjtBQUMzQyxRQUFJdmlCLElBQUksR0FBRyxJQUFYO0FBQ0EsV0FBT3VCLE1BQU0sQ0FBQ29PLGdCQUFQLENBQXdCLFlBQVk7QUFDekM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFVBQUk1UCxPQUFPLEdBQUcxQyxDQUFDLENBQUNVLEtBQUYsQ0FBUWlDLElBQUksQ0FBQ2dLLGtCQUFMLENBQXdCakssT0FBaEMsQ0FBZCxDQU55QyxDQVF6QztBQUNBOzs7QUFDQTFDLE9BQUMsQ0FBQ2tJLE1BQUYsQ0FBU3hGLE9BQVQsRUFBa0J3aUIsZ0JBQWxCOztBQUVBeGlCLGFBQU8sQ0FBQzhMLE1BQVIsR0FBaUI3TCxJQUFJLENBQUM0ZCxpQkFBdEI7QUFDQSxhQUFPN2QsT0FBTyxDQUFDMkssU0FBZixDQWJ5QyxDQWN6Qzs7QUFDQSxVQUFJOFgsV0FBVyxHQUFHLElBQUl4WixpQkFBSixDQUNoQmhKLElBQUksQ0FBQ2dLLGtCQUFMLENBQXdCakgsY0FEUixFQUVoQi9DLElBQUksQ0FBQ2dLLGtCQUFMLENBQXdCN0UsUUFGUixFQUdoQnBGLE9BSGdCLENBQWxCO0FBSUEsYUFBTyxJQUFJZ0osTUFBSixDQUFXL0ksSUFBSSxDQUFDb2EsWUFBaEIsRUFBOEJvSSxXQUE5QixDQUFQO0FBQ0QsS0FwQk0sQ0FBUDtBQXFCRCxHQXBvQm9DO0FBdW9CckM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQUYsb0JBQWtCLEVBQUUsVUFBVTdHLFVBQVYsRUFBc0IwRyxTQUF0QixFQUFpQztBQUNuRCxRQUFJbmlCLElBQUksR0FBRyxJQUFYOztBQUNBdUIsVUFBTSxDQUFDb08sZ0JBQVAsQ0FBd0IsWUFBWTtBQUVsQztBQUNBO0FBQ0EsVUFBSTNQLElBQUksQ0FBQytjLE1BQVQsRUFBaUI7QUFDZi9jLFlBQUksQ0FBQ2tkLGtCQUFMLENBQXdCekcsS0FBeEI7QUFDRCxPQU5pQyxDQVFsQztBQUNBOzs7QUFDQSxVQUFJZ00sV0FBVyxHQUFHLEVBQWxCOztBQUNBemlCLFVBQUksQ0FBQ29kLFVBQUwsQ0FBZ0I5UixPQUFoQixDQUF3QixVQUFVdEosR0FBVixFQUFlOEMsRUFBZixFQUFtQjtBQUN6QyxZQUFJLENBQUMyVyxVQUFVLENBQUMxYSxHQUFYLENBQWUrRCxFQUFmLENBQUwsRUFDRTJkLFdBQVcsQ0FBQ25VLElBQVosQ0FBaUJ4SixFQUFqQjtBQUNILE9BSEQ7O0FBSUF6SCxPQUFDLENBQUNLLElBQUYsQ0FBTytrQixXQUFQLEVBQW9CLFVBQVUzZCxFQUFWLEVBQWM7QUFDaEM5RSxZQUFJLENBQUNxZixnQkFBTCxDQUFzQnZhLEVBQXRCO0FBQ0QsT0FGRCxFQWZrQyxDQW1CbEM7QUFDQTtBQUNBOzs7QUFDQTJXLGdCQUFVLENBQUNuUSxPQUFYLENBQW1CLFVBQVV0SixHQUFWLEVBQWU4QyxFQUFmLEVBQW1CO0FBQ3BDOUUsWUFBSSxDQUFDMGdCLFVBQUwsQ0FBZ0I1YixFQUFoQixFQUFvQjlDLEdBQXBCO0FBQ0QsT0FGRCxFQXRCa0MsQ0EwQmxDO0FBQ0E7QUFDQTs7QUFDQSxVQUFJaEMsSUFBSSxDQUFDb2QsVUFBTCxDQUFnQnJlLElBQWhCLE9BQTJCMGMsVUFBVSxDQUFDMWMsSUFBWCxFQUEvQixFQUFrRDtBQUNoRDJqQixlQUFPLENBQUNwYixLQUFSLENBQWMsMkRBQ1osdURBREYsRUFFRXRILElBQUksQ0FBQ2dLLGtCQUZQO0FBR0EsY0FBTXRILEtBQUssQ0FDVCwyREFDRSwrREFERixHQUVFLDJCQUZGLEdBR0UxRCxLQUFLLENBQUN1USxTQUFOLENBQWdCdlAsSUFBSSxDQUFDZ0ssa0JBQUwsQ0FBd0I3RSxRQUF4QyxDQUpPLENBQVg7QUFLRDs7QUFDRG5GLFVBQUksQ0FBQ29kLFVBQUwsQ0FBZ0I5UixPQUFoQixDQUF3QixVQUFVdEosR0FBVixFQUFlOEMsRUFBZixFQUFtQjtBQUN6QyxZQUFJLENBQUMyVyxVQUFVLENBQUMxYSxHQUFYLENBQWUrRCxFQUFmLENBQUwsRUFDRSxNQUFNcEMsS0FBSyxDQUFDLG1EQUFtRG9DLEVBQXBELENBQVg7QUFDSCxPQUhELEVBdkNrQyxDQTRDbEM7OztBQUNBcWQsZUFBUyxDQUFDN1csT0FBVixDQUFrQixVQUFVdEosR0FBVixFQUFlOEMsRUFBZixFQUFtQjtBQUNuQzlFLFlBQUksQ0FBQ29mLFlBQUwsQ0FBa0J0YSxFQUFsQixFQUFzQjlDLEdBQXRCO0FBQ0QsT0FGRDtBQUlBaEMsVUFBSSxDQUFDc2QsbUJBQUwsR0FBMkI2RSxTQUFTLENBQUNwakIsSUFBVixLQUFtQmlCLElBQUksQ0FBQytjLE1BQW5EO0FBQ0QsS0FsREQ7QUFtREQsR0Fuc0JvQztBQXFzQnJDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBbmEsTUFBSSxFQUFFLFlBQVk7QUFDaEIsUUFBSTVDLElBQUksR0FBRyxJQUFYO0FBQ0EsUUFBSUEsSUFBSSxDQUFDK1MsUUFBVCxFQUNFO0FBQ0YvUyxRQUFJLENBQUMrUyxRQUFMLEdBQWdCLElBQWhCOztBQUNBMVYsS0FBQyxDQUFDSyxJQUFGLENBQU9zQyxJQUFJLENBQUN1ZCxZQUFaLEVBQTBCLFVBQVUxRixNQUFWLEVBQWtCO0FBQzFDQSxZQUFNLENBQUNqVixJQUFQO0FBQ0QsS0FGRCxFQUxnQixDQVNoQjtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQXZGLEtBQUMsQ0FBQ0ssSUFBRixDQUFPc0MsSUFBSSxDQUFDbWUsZ0NBQVosRUFBOEMsVUFBVWxDLENBQVYsRUFBYTtBQUN6REEsT0FBQyxDQUFDblksU0FBRixHQUR5RCxDQUN6QztBQUNqQixLQUZEOztBQUdBOUQsUUFBSSxDQUFDbWUsZ0NBQUwsR0FBd0MsSUFBeEMsQ0FqQmdCLENBbUJoQjs7QUFDQW5lLFFBQUksQ0FBQ29kLFVBQUwsR0FBa0IsSUFBbEI7QUFDQXBkLFFBQUksQ0FBQ2tkLGtCQUFMLEdBQTBCLElBQTFCO0FBQ0FsZCxRQUFJLENBQUMrZCxZQUFMLEdBQW9CLElBQXBCO0FBQ0EvZCxRQUFJLENBQUNnZSxrQkFBTCxHQUEwQixJQUExQjtBQUNBaGUsUUFBSSxDQUFDMmlCLGlCQUFMLEdBQXlCLElBQXpCO0FBQ0EzaUIsUUFBSSxDQUFDNGlCLGdCQUFMLEdBQXdCLElBQXhCO0FBRUF0Z0IsV0FBTyxDQUFDLFlBQUQsQ0FBUCxJQUF5QkEsT0FBTyxDQUFDLFlBQUQsQ0FBUCxDQUFzQnlVLEtBQXRCLENBQTRCQyxtQkFBNUIsQ0FDdkIsZ0JBRHVCLEVBQ0wsdUJBREssRUFDb0IsQ0FBQyxDQURyQixDQUF6QjtBQUVELEdBeHVCb0M7QUEwdUJyQ3dHLHNCQUFvQixFQUFFLFVBQVVxRixLQUFWLEVBQWlCO0FBQ3JDLFFBQUk3aUIsSUFBSSxHQUFHLElBQVg7O0FBQ0F1QixVQUFNLENBQUNvTyxnQkFBUCxDQUF3QixZQUFZO0FBQ2xDLFVBQUltVCxHQUFHLEdBQUcsSUFBSUMsSUFBSixFQUFWOztBQUVBLFVBQUkvaUIsSUFBSSxDQUFDcWUsTUFBVCxFQUFpQjtBQUNmLFlBQUkyRSxRQUFRLEdBQUdGLEdBQUcsR0FBRzlpQixJQUFJLENBQUNpakIsZUFBMUI7QUFDQTNnQixlQUFPLENBQUMsWUFBRCxDQUFQLElBQXlCQSxPQUFPLENBQUMsWUFBRCxDQUFQLENBQXNCeVUsS0FBdEIsQ0FBNEJDLG1CQUE1QixDQUN2QixnQkFEdUIsRUFDTCxtQkFBbUJoWCxJQUFJLENBQUNxZSxNQUF4QixHQUFpQyxRQUQ1QixFQUNzQzJFLFFBRHRDLENBQXpCO0FBRUQ7O0FBRURoakIsVUFBSSxDQUFDcWUsTUFBTCxHQUFjd0UsS0FBZDtBQUNBN2lCLFVBQUksQ0FBQ2lqQixlQUFMLEdBQXVCSCxHQUF2QjtBQUNELEtBWEQ7QUFZRDtBQXh2Qm9DLENBQXZDLEUsQ0EydkJBO0FBQ0E7QUFDQTs7O0FBQ0F2UyxrQkFBa0IsQ0FBQ0MsZUFBbkIsR0FBcUMsVUFBVTFHLGlCQUFWLEVBQTZCa0csT0FBN0IsRUFBc0M7QUFDekU7QUFDQSxNQUFJalEsT0FBTyxHQUFHK0osaUJBQWlCLENBQUMvSixPQUFoQyxDQUZ5RSxDQUl6RTtBQUNBOztBQUNBLE1BQUlBLE9BQU8sQ0FBQ21qQixZQUFSLElBQXdCbmpCLE9BQU8sQ0FBQ29qQixhQUFwQyxFQUNFLE9BQU8sS0FBUCxDQVB1RSxDQVN6RTtBQUNBO0FBQ0E7QUFDQTs7QUFDQSxNQUFJcGpCLE9BQU8sQ0FBQzRMLElBQVIsSUFBaUI1TCxPQUFPLENBQUNtSixLQUFSLElBQWlCLENBQUNuSixPQUFPLENBQUMyTCxJQUEvQyxFQUFzRCxPQUFPLEtBQVAsQ0FibUIsQ0FlekU7QUFDQTs7QUFDQSxNQUFJM0wsT0FBTyxDQUFDOEwsTUFBWixFQUFvQjtBQUNsQixRQUFJO0FBQ0ZqSCxxQkFBZSxDQUFDd2UseUJBQWhCLENBQTBDcmpCLE9BQU8sQ0FBQzhMLE1BQWxEO0FBQ0QsS0FGRCxDQUVFLE9BQU9uSCxDQUFQLEVBQVU7QUFDVixVQUFJQSxDQUFDLENBQUN6RyxJQUFGLEtBQVcsZ0JBQWYsRUFBaUM7QUFDL0IsZUFBTyxLQUFQO0FBQ0QsT0FGRCxNQUVPO0FBQ0wsY0FBTXlHLENBQU47QUFDRDtBQUNGO0FBQ0YsR0EzQndFLENBNkJ6RTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQSxTQUFPLENBQUNzTCxPQUFPLENBQUNxVCxRQUFSLEVBQUQsSUFBdUIsQ0FBQ3JULE9BQU8sQ0FBQ3NULFdBQVIsRUFBL0I7QUFDRCxDQXRDRDs7QUF3Q0EsSUFBSTNCLDRCQUE0QixHQUFHLFVBQVU0QixRQUFWLEVBQW9CO0FBQ3JELFNBQU9sbUIsQ0FBQyxDQUFDOFMsR0FBRixDQUFNb1QsUUFBTixFQUFnQixVQUFVMVgsTUFBVixFQUFrQjJYLFNBQWxCLEVBQTZCO0FBQ2xELFdBQU9ubUIsQ0FBQyxDQUFDOFMsR0FBRixDQUFNdEUsTUFBTixFQUFjLFVBQVVsTyxLQUFWLEVBQWlCOGxCLEtBQWpCLEVBQXdCO0FBQzNDLGFBQU8sQ0FBQyxVQUFVNWlCLElBQVYsQ0FBZTRpQixLQUFmLENBQVI7QUFDRCxLQUZNLENBQVA7QUFHRCxHQUpNLENBQVA7QUFLRCxDQU5EOztBQVFBOW1CLGNBQWMsQ0FBQzRULGtCQUFmLEdBQW9DQSxrQkFBcEMsQzs7Ozs7Ozs7Ozs7QUNoL0JBdlQsTUFBTSxDQUFDcWMsTUFBUCxDQUFjO0FBQUNxSyx1QkFBcUIsRUFBQyxNQUFJQTtBQUEzQixDQUFkO0FBQ08sTUFBTUEscUJBQXFCLEdBQUcsSUFBSyxNQUFNQSxxQkFBTixDQUE0QjtBQUNwRW5LLGFBQVcsR0FBRztBQUNaLFNBQUtvSyxpQkFBTCxHQUF5QnRqQixNQUFNLENBQUN1akIsTUFBUCxDQUFjLElBQWQsQ0FBekI7QUFDRDs7QUFFREMsTUFBSSxDQUFDNWxCLElBQUQsRUFBTzZsQixJQUFQLEVBQWE7QUFDZixRQUFJLENBQUU3bEIsSUFBTixFQUFZO0FBQ1YsYUFBTyxJQUFJMkcsZUFBSixFQUFQO0FBQ0Q7O0FBRUQsUUFBSSxDQUFFa2YsSUFBTixFQUFZO0FBQ1YsYUFBT0MsZ0JBQWdCLENBQUM5bEIsSUFBRCxFQUFPLEtBQUswbEIsaUJBQVosQ0FBdkI7QUFDRDs7QUFFRCxRQUFJLENBQUVHLElBQUksQ0FBQ0UsMkJBQVgsRUFBd0M7QUFDdENGLFVBQUksQ0FBQ0UsMkJBQUwsR0FBbUMzakIsTUFBTSxDQUFDdWpCLE1BQVAsQ0FBYyxJQUFkLENBQW5DO0FBQ0QsS0FYYyxDQWFmO0FBQ0E7OztBQUNBLFdBQU9HLGdCQUFnQixDQUFDOWxCLElBQUQsRUFBTzZsQixJQUFJLENBQUNFLDJCQUFaLENBQXZCO0FBQ0Q7O0FBckJtRSxDQUFqQyxFQUE5Qjs7QUF3QlAsU0FBU0QsZ0JBQVQsQ0FBMEI5bEIsSUFBMUIsRUFBZ0NnbUIsV0FBaEMsRUFBNkM7QUFDM0MsU0FBUWhtQixJQUFJLElBQUlnbUIsV0FBVCxHQUNIQSxXQUFXLENBQUNobUIsSUFBRCxDQURSLEdBRUhnbUIsV0FBVyxDQUFDaG1CLElBQUQsQ0FBWCxHQUFvQixJQUFJMkcsZUFBSixDQUFvQjNHLElBQXBCLENBRnhCO0FBR0QsQzs7Ozs7Ozs7Ozs7QUM3QkR0QixjQUFjLENBQUN1bkIsc0JBQWYsR0FBd0MsVUFDdENDLFNBRHNDLEVBQzNCcGtCLE9BRDJCLEVBQ2xCO0FBQ3BCLE1BQUlDLElBQUksR0FBRyxJQUFYO0FBQ0FBLE1BQUksQ0FBQzZKLEtBQUwsR0FBYSxJQUFJaEssZUFBSixDQUFvQnNrQixTQUFwQixFQUErQnBrQixPQUEvQixDQUFiO0FBQ0QsQ0FKRDs7QUFNQTFDLENBQUMsQ0FBQ2tJLE1BQUYsQ0FBUzVJLGNBQWMsQ0FBQ3VuQixzQkFBZixDQUFzQ3BtQixTQUEvQyxFQUEwRDtBQUN4RCtsQixNQUFJLEVBQUUsVUFBVTVsQixJQUFWLEVBQWdCO0FBQ3BCLFFBQUkrQixJQUFJLEdBQUcsSUFBWDtBQUNBLFFBQUl2QyxHQUFHLEdBQUcsRUFBVjs7QUFDQUosS0FBQyxDQUFDSyxJQUFGLENBQ0UsQ0FBQyxNQUFELEVBQVMsU0FBVCxFQUFvQixRQUFwQixFQUE4QixRQUE5QixFQUF3QyxRQUF4QyxFQUNDLFFBREQsRUFDVyxjQURYLEVBQzJCLFlBRDNCLEVBQ3lDLHlCQUR6QyxFQUVDLGdCQUZELEVBRW1CLGVBRm5CLENBREYsRUFJRSxVQUFVMG1CLENBQVYsRUFBYTtBQUNYM21CLFNBQUcsQ0FBQzJtQixDQUFELENBQUgsR0FBUy9tQixDQUFDLENBQUNHLElBQUYsQ0FBT3dDLElBQUksQ0FBQzZKLEtBQUwsQ0FBV3VhLENBQVgsQ0FBUCxFQUFzQnBrQixJQUFJLENBQUM2SixLQUEzQixFQUFrQzVMLElBQWxDLENBQVQ7QUFDRCxLQU5IOztBQU9BLFdBQU9SLEdBQVA7QUFDRDtBQVp1RCxDQUExRCxFLENBZ0JBO0FBQ0E7QUFDQTs7O0FBQ0FkLGNBQWMsQ0FBQzBuQiw2QkFBZixHQUErQ2huQixDQUFDLENBQUNpbkIsSUFBRixDQUFPLFlBQVk7QUFDaEUsTUFBSUMsaUJBQWlCLEdBQUcsRUFBeEI7QUFFQSxNQUFJQyxRQUFRLEdBQUcxUyxPQUFPLENBQUNDLEdBQVIsQ0FBWTBTLFNBQTNCOztBQUVBLE1BQUkzUyxPQUFPLENBQUNDLEdBQVIsQ0FBWTJTLGVBQWhCLEVBQWlDO0FBQy9CSCxxQkFBaUIsQ0FBQ2xpQixRQUFsQixHQUE2QnlQLE9BQU8sQ0FBQ0MsR0FBUixDQUFZMlMsZUFBekM7QUFDRDs7QUFFRCxNQUFJLENBQUVGLFFBQU4sRUFDRSxNQUFNLElBQUk5aEIsS0FBSixDQUFVLHNDQUFWLENBQU47QUFFRixTQUFPLElBQUkvRixjQUFjLENBQUN1bkIsc0JBQW5CLENBQTBDTSxRQUExQyxFQUFvREQsaUJBQXBELENBQVA7QUFDRCxDQWI4QyxDQUEvQyxDOzs7Ozs7Ozs7Ozs7QUN6QkEsTUFBSUksYUFBSjs7QUFBa0J4b0IsU0FBTyxDQUFDQyxJQUFSLENBQWEsc0NBQWIsRUFBb0Q7QUFBQ3dvQixXQUFPLENBQUN2b0IsQ0FBRCxFQUFHO0FBQUNzb0IsbUJBQWEsR0FBQ3RvQixDQUFkO0FBQWdCOztBQUE1QixHQUFwRCxFQUFrRixDQUFsRjtBQUFsQjtBQUNBOztBQUVBOzs7O0FBSUFxQyxPQUFLLEdBQUcsRUFBUjtBQUVBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFpQkFBLE9BQUssQ0FBQ2lMLFVBQU4sR0FBbUIsU0FBU0EsVUFBVCxDQUFvQjFMLElBQXBCLEVBQTBCOEIsT0FBMUIsRUFBbUM7QUFDcEQsUUFBSSxDQUFDOUIsSUFBRCxJQUFVQSxJQUFJLEtBQUssSUFBdkIsRUFBOEI7QUFDNUJzRCxZQUFNLENBQUNrVCxNQUFQLENBQWMsNERBQ0EseURBREEsR0FFQSxnREFGZDs7QUFHQXhXLFVBQUksR0FBRyxJQUFQO0FBQ0Q7O0FBRUQsUUFBSUEsSUFBSSxLQUFLLElBQVQsSUFBaUIsT0FBT0EsSUFBUCxLQUFnQixRQUFyQyxFQUErQztBQUM3QyxZQUFNLElBQUl5RSxLQUFKLENBQ0osaUVBREksQ0FBTjtBQUVEOztBQUVELFFBQUkzQyxPQUFPLElBQUlBLE9BQU8sQ0FBQ21MLE9BQXZCLEVBQWdDO0FBQzlCO0FBQ0E7QUFDQTtBQUNBO0FBQ0FuTCxhQUFPLEdBQUc7QUFBQzhrQixrQkFBVSxFQUFFOWtCO0FBQWIsT0FBVjtBQUNELEtBbkJtRCxDQW9CcEQ7OztBQUNBLFFBQUlBLE9BQU8sSUFBSUEsT0FBTyxDQUFDK2tCLE9BQW5CLElBQThCLENBQUMva0IsT0FBTyxDQUFDOGtCLFVBQTNDLEVBQXVEO0FBQ3JEOWtCLGFBQU8sQ0FBQzhrQixVQUFSLEdBQXFCOWtCLE9BQU8sQ0FBQytrQixPQUE3QjtBQUNEOztBQUVEL2tCLFdBQU87QUFDTDhrQixnQkFBVSxFQUFFM2xCLFNBRFA7QUFFTDZsQixrQkFBWSxFQUFFLFFBRlQ7QUFHTHJhLGVBQVMsRUFBRSxJQUhOO0FBSUxzYSxhQUFPLEVBQUU5bEIsU0FKSjtBQUtMK2xCLHlCQUFtQixFQUFFO0FBTGhCLE9BTUFsbEIsT0FOQSxDQUFQOztBQVNBLFlBQVFBLE9BQU8sQ0FBQ2dsQixZQUFoQjtBQUNBLFdBQUssT0FBTDtBQUNFLGFBQUtHLFVBQUwsR0FBa0IsWUFBWTtBQUM1QixjQUFJQyxHQUFHLEdBQUdsbkIsSUFBSSxHQUFHbW5CLEdBQUcsQ0FBQ0MsWUFBSixDQUFpQixpQkFBaUJwbkIsSUFBbEMsQ0FBSCxHQUE2Q3FuQixNQUFNLENBQUNDLFFBQWxFO0FBQ0EsaUJBQU8sSUFBSTdtQixLQUFLLENBQUNELFFBQVYsQ0FBbUIwbUIsR0FBRyxDQUFDSyxTQUFKLENBQWMsRUFBZCxDQUFuQixDQUFQO0FBQ0QsU0FIRDs7QUFJQTs7QUFDRixXQUFLLFFBQUw7QUFDQTtBQUNFLGFBQUtOLFVBQUwsR0FBa0IsWUFBWTtBQUM1QixjQUFJQyxHQUFHLEdBQUdsbkIsSUFBSSxHQUFHbW5CLEdBQUcsQ0FBQ0MsWUFBSixDQUFpQixpQkFBaUJwbkIsSUFBbEMsQ0FBSCxHQUE2Q3FuQixNQUFNLENBQUNDLFFBQWxFO0FBQ0EsaUJBQU9KLEdBQUcsQ0FBQ3JnQixFQUFKLEVBQVA7QUFDRCxTQUhEOztBQUlBO0FBYkY7O0FBZ0JBLFNBQUs0SCxVQUFMLEdBQWtCOUgsZUFBZSxDQUFDK0gsYUFBaEIsQ0FBOEI1TSxPQUFPLENBQUMySyxTQUF0QyxDQUFsQjtBQUVBLFFBQUksQ0FBRXpNLElBQUYsSUFBVThCLE9BQU8sQ0FBQzhrQixVQUFSLEtBQXVCLElBQXJDLEVBQ0U7QUFDQSxXQUFLWSxXQUFMLEdBQW1CLElBQW5CLENBRkYsS0FHSyxJQUFJMWxCLE9BQU8sQ0FBQzhrQixVQUFaLEVBQ0gsS0FBS1ksV0FBTCxHQUFtQjFsQixPQUFPLENBQUM4a0IsVUFBM0IsQ0FERyxLQUVBLElBQUl0akIsTUFBTSxDQUFDbWtCLFFBQVgsRUFDSCxLQUFLRCxXQUFMLEdBQW1CbGtCLE1BQU0sQ0FBQ3NqQixVQUExQixDQURHLEtBR0gsS0FBS1ksV0FBTCxHQUFtQmxrQixNQUFNLENBQUNva0IsTUFBMUI7O0FBRUYsUUFBSSxDQUFDNWxCLE9BQU8sQ0FBQ2lsQixPQUFiLEVBQXNCO0FBQ3BCO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsVUFBSS9tQixJQUFJLElBQUksS0FBS3duQixXQUFMLEtBQXFCbGtCLE1BQU0sQ0FBQ29rQixNQUFwQyxJQUNBLE9BQU9ocEIsY0FBUCxLQUEwQixXQUQxQixJQUVBQSxjQUFjLENBQUMwbkIsNkJBRm5CLEVBRWtEO0FBQ2hEdGtCLGVBQU8sQ0FBQ2lsQixPQUFSLEdBQWtCcm9CLGNBQWMsQ0FBQzBuQiw2QkFBZixFQUFsQjtBQUNELE9BSkQsTUFJTztBQUNMLGNBQU07QUFBRVg7QUFBRixZQUNKaG5CLE9BQU8sQ0FBQyw4QkFBRCxDQURUOztBQUVBcUQsZUFBTyxDQUFDaWxCLE9BQVIsR0FBa0J0QixxQkFBbEI7QUFDRDtBQUNGOztBQUVELFNBQUtrQyxXQUFMLEdBQW1CN2xCLE9BQU8sQ0FBQ2lsQixPQUFSLENBQWdCbkIsSUFBaEIsQ0FBcUI1bEIsSUFBckIsRUFBMkIsS0FBS3duQixXQUFoQyxDQUFuQjtBQUNBLFNBQUtJLEtBQUwsR0FBYTVuQixJQUFiO0FBQ0EsU0FBSyttQixPQUFMLEdBQWVqbEIsT0FBTyxDQUFDaWxCLE9BQXZCOztBQUVBLFNBQUtjLHNCQUFMLENBQTRCN25CLElBQTVCLEVBQWtDOEIsT0FBbEMsRUFsRm9ELENBb0ZwRDtBQUNBO0FBQ0E7OztBQUNBLFFBQUlBLE9BQU8sQ0FBQ2dtQixxQkFBUixLQUFrQyxLQUF0QyxFQUE2QztBQUMzQyxVQUFJO0FBQ0YsYUFBS0Msc0JBQUwsQ0FBNEI7QUFDMUJDLHFCQUFXLEVBQUVsbUIsT0FBTyxDQUFDbW1CLHNCQUFSLEtBQW1DO0FBRHRCLFNBQTVCO0FBR0QsT0FKRCxDQUlFLE9BQU81ZSxLQUFQLEVBQWM7QUFDZDtBQUNBLFlBQUlBLEtBQUssQ0FBQ3dVLE9BQU4sZ0NBQXNDN2QsSUFBdEMsZ0NBQUosRUFDRSxNQUFNLElBQUl5RSxLQUFKLGlEQUFrRHpFLElBQWxELFFBQU47QUFDRixjQUFNcUosS0FBTjtBQUNEO0FBQ0YsS0FsR21ELENBb0dwRDs7O0FBQ0EsUUFBSWhGLE9BQU8sQ0FBQzZqQixXQUFSLElBQ0EsQ0FBRXBtQixPQUFPLENBQUNrbEIsbUJBRFYsSUFFQSxLQUFLUSxXQUZMLElBR0EsS0FBS0EsV0FBTCxDQUFpQlcsT0FIckIsRUFHOEI7QUFDNUIsV0FBS1gsV0FBTCxDQUFpQlcsT0FBakIsQ0FBeUIsSUFBekIsRUFBK0IsTUFBTSxLQUFLdGQsSUFBTCxFQUFyQyxFQUFrRDtBQUNoRHVkLGVBQU8sRUFBRTtBQUR1QyxPQUFsRDtBQUdEO0FBQ0YsR0E3R0Q7O0FBK0dBaG1CLFFBQU0sQ0FBQ0MsTUFBUCxDQUFjNUIsS0FBSyxDQUFDaUwsVUFBTixDQUFpQjdMLFNBQS9CLEVBQTBDO0FBQ3hDZ29CLDBCQUFzQixDQUFDN25CLElBQUQsUUFFbkI7QUFBQSxVQUYwQjtBQUMzQmlvQiw4QkFBc0IsR0FBRztBQURFLE9BRTFCO0FBQ0QsWUFBTWxtQixJQUFJLEdBQUcsSUFBYjs7QUFDQSxVQUFJLEVBQUdBLElBQUksQ0FBQ3lsQixXQUFMLElBQ0F6bEIsSUFBSSxDQUFDeWxCLFdBQUwsQ0FBaUJhLGFBRHBCLENBQUosRUFDd0M7QUFDdEM7QUFDRCxPQUxBLENBT0Q7QUFDQTtBQUNBOzs7QUFDQSxZQUFNQyxFQUFFLEdBQUd2bUIsSUFBSSxDQUFDeWxCLFdBQUwsQ0FBaUJhLGFBQWpCLENBQStCcm9CLElBQS9CLEVBQXFDO0FBQzlDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0F1b0IsbUJBQVcsQ0FBQ0MsU0FBRCxFQUFZQyxLQUFaLEVBQW1CO0FBQzVCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxjQUFJRCxTQUFTLEdBQUcsQ0FBWixJQUFpQkMsS0FBckIsRUFDRTFtQixJQUFJLENBQUM0bEIsV0FBTCxDQUFpQmUsY0FBakI7QUFFRixjQUFJRCxLQUFKLEVBQ0UxbUIsSUFBSSxDQUFDNGxCLFdBQUwsQ0FBaUIvZixNQUFqQixDQUF3QixFQUF4QjtBQUNILFNBdEI2Qzs7QUF3QjlDO0FBQ0E7QUFDQTZCLGNBQU0sQ0FBQ2tmLEdBQUQsRUFBTTtBQUNWLGNBQUlDLE9BQU8sR0FBR0MsT0FBTyxDQUFDQyxPQUFSLENBQWdCSCxHQUFHLENBQUM5aEIsRUFBcEIsQ0FBZDs7QUFDQSxjQUFJOUMsR0FBRyxHQUFHaEMsSUFBSSxDQUFDNGxCLFdBQUwsQ0FBaUIzYyxPQUFqQixDQUF5QjRkLE9BQXpCLENBQVYsQ0FGVSxDQUlWO0FBQ0E7QUFDQTs7O0FBQ0EsY0FBSUQsR0FBRyxDQUFDQSxHQUFKLEtBQVksU0FBaEIsRUFBMkI7QUFDekIsZ0JBQUlJLE9BQU8sR0FBR0osR0FBRyxDQUFDSSxPQUFsQjs7QUFDQSxnQkFBSSxDQUFDQSxPQUFMLEVBQWM7QUFDWixrQkFBSWhsQixHQUFKLEVBQ0VoQyxJQUFJLENBQUM0bEIsV0FBTCxDQUFpQi9mLE1BQWpCLENBQXdCZ2hCLE9BQXhCO0FBQ0gsYUFIRCxNQUdPLElBQUksQ0FBQzdrQixHQUFMLEVBQVU7QUFDZmhDLGtCQUFJLENBQUM0bEIsV0FBTCxDQUFpQjVnQixNQUFqQixDQUF3QmdpQixPQUF4QjtBQUNELGFBRk0sTUFFQTtBQUNMO0FBQ0FobkIsa0JBQUksQ0FBQzRsQixXQUFMLENBQWlCbGUsTUFBakIsQ0FBd0JtZixPQUF4QixFQUFpQ0csT0FBakM7QUFDRDs7QUFDRDtBQUNELFdBWkQsTUFZTyxJQUFJSixHQUFHLENBQUNBLEdBQUosS0FBWSxPQUFoQixFQUF5QjtBQUM5QixnQkFBSTVrQixHQUFKLEVBQVM7QUFDUCxvQkFBTSxJQUFJVSxLQUFKLENBQVUsNERBQVYsQ0FBTjtBQUNEOztBQUNEMUMsZ0JBQUksQ0FBQzRsQixXQUFMLENBQWlCNWdCLE1BQWpCO0FBQTBCRCxpQkFBRyxFQUFFOGhCO0FBQS9CLGVBQTJDRCxHQUFHLENBQUMvYSxNQUEvQztBQUNELFdBTE0sTUFLQSxJQUFJK2EsR0FBRyxDQUFDQSxHQUFKLEtBQVksU0FBaEIsRUFBMkI7QUFDaEMsZ0JBQUksQ0FBQzVrQixHQUFMLEVBQ0UsTUFBTSxJQUFJVSxLQUFKLENBQVUseURBQVYsQ0FBTjs7QUFDRjFDLGdCQUFJLENBQUM0bEIsV0FBTCxDQUFpQi9mLE1BQWpCLENBQXdCZ2hCLE9BQXhCO0FBQ0QsV0FKTSxNQUlBLElBQUlELEdBQUcsQ0FBQ0EsR0FBSixLQUFZLFNBQWhCLEVBQTJCO0FBQ2hDLGdCQUFJLENBQUM1a0IsR0FBTCxFQUNFLE1BQU0sSUFBSVUsS0FBSixDQUFVLHVDQUFWLENBQU47QUFDRixrQkFBTW1XLElBQUksR0FBR3hZLE1BQU0sQ0FBQ3dZLElBQVAsQ0FBWStOLEdBQUcsQ0FBQy9hLE1BQWhCLENBQWI7O0FBQ0EsZ0JBQUlnTixJQUFJLENBQUMvUSxNQUFMLEdBQWMsQ0FBbEIsRUFBcUI7QUFDbkIsa0JBQUl5YixRQUFRLEdBQUcsRUFBZjtBQUNBMUssa0JBQUksQ0FBQ3ZOLE9BQUwsQ0FBYTFOLEdBQUcsSUFBSTtBQUNsQixzQkFBTUQsS0FBSyxHQUFHaXBCLEdBQUcsQ0FBQy9hLE1BQUosQ0FBV2pPLEdBQVgsQ0FBZDs7QUFDQSxvQkFBSW9CLEtBQUssQ0FBQ2tnQixNQUFOLENBQWFsZCxHQUFHLENBQUNwRSxHQUFELENBQWhCLEVBQXVCRCxLQUF2QixDQUFKLEVBQW1DO0FBQ2pDO0FBQ0Q7O0FBQ0Qsb0JBQUksT0FBT0EsS0FBUCxLQUFpQixXQUFyQixFQUFrQztBQUNoQyxzQkFBSSxDQUFDNGxCLFFBQVEsQ0FBQzBELE1BQWQsRUFBc0I7QUFDcEIxRCw0QkFBUSxDQUFDMEQsTUFBVCxHQUFrQixFQUFsQjtBQUNEOztBQUNEMUQsMEJBQVEsQ0FBQzBELE1BQVQsQ0FBZ0JycEIsR0FBaEIsSUFBdUIsQ0FBdkI7QUFDRCxpQkFMRCxNQUtPO0FBQ0wsc0JBQUksQ0FBQzJsQixRQUFRLENBQUMyRCxJQUFkLEVBQW9CO0FBQ2xCM0QsNEJBQVEsQ0FBQzJELElBQVQsR0FBZ0IsRUFBaEI7QUFDRDs7QUFDRDNELDBCQUFRLENBQUMyRCxJQUFULENBQWN0cEIsR0FBZCxJQUFxQkQsS0FBckI7QUFDRDtBQUNGLGVBaEJEOztBQWlCQSxrQkFBSTBDLE1BQU0sQ0FBQ3dZLElBQVAsQ0FBWTBLLFFBQVosRUFBc0J6YixNQUF0QixHQUErQixDQUFuQyxFQUFzQztBQUNwQzlILG9CQUFJLENBQUM0bEIsV0FBTCxDQUFpQmxlLE1BQWpCLENBQXdCbWYsT0FBeEIsRUFBaUN0RCxRQUFqQztBQUNEO0FBQ0Y7QUFDRixXQTNCTSxNQTJCQTtBQUNMLGtCQUFNLElBQUk3Z0IsS0FBSixDQUFVLDRDQUFWLENBQU47QUFDRDtBQUNGLFNBcEY2Qzs7QUFzRjlDO0FBQ0F5a0IsaUJBQVMsR0FBRztBQUNWbm5CLGNBQUksQ0FBQzRsQixXQUFMLENBQWlCd0IsZUFBakI7QUFDRCxTQXpGNkM7O0FBMkY5QztBQUNBO0FBQ0FDLHFCQUFhLEdBQUc7QUFDZHJuQixjQUFJLENBQUM0bEIsV0FBTCxDQUFpQnlCLGFBQWpCO0FBQ0QsU0EvRjZDOztBQWdHOUNDLHlCQUFpQixHQUFHO0FBQ2xCLGlCQUFPdG5CLElBQUksQ0FBQzRsQixXQUFMLENBQWlCMEIsaUJBQWpCLEVBQVA7QUFDRCxTQWxHNkM7O0FBb0c5QztBQUNBQyxjQUFNLENBQUN6aUIsRUFBRCxFQUFLO0FBQ1QsaUJBQU85RSxJQUFJLENBQUNpSixPQUFMLENBQWFuRSxFQUFiLENBQVA7QUFDRCxTQXZHNkM7O0FBeUc5QztBQUNBMGlCLHNCQUFjLEdBQUc7QUFDZixpQkFBT3huQixJQUFQO0FBQ0Q7O0FBNUc2QyxPQUFyQyxDQUFYOztBQStHQSxVQUFJLENBQUV1bUIsRUFBTixFQUFVO0FBQ1IsY0FBTXpLLE9BQU8sbURBQTJDN2QsSUFBM0MsT0FBYjs7QUFDQSxZQUFJaW9CLHNCQUFzQixLQUFLLElBQS9CLEVBQXFDO0FBQ25DO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0F4RCxpQkFBTyxDQUFDK0UsSUFBUixHQUFlL0UsT0FBTyxDQUFDK0UsSUFBUixDQUFhM0wsT0FBYixDQUFmLEdBQXVDNEcsT0FBTyxDQUFDZ0YsR0FBUixDQUFZNUwsT0FBWixDQUF2QztBQUNELFNBVEQsTUFTTztBQUNMLGdCQUFNLElBQUlwWixLQUFKLENBQVVvWixPQUFWLENBQU47QUFDRDtBQUNGO0FBQ0YsS0EzSXVDOztBQTZJeEM7QUFDQTtBQUNBO0FBRUE2TCxvQkFBZ0IsQ0FBQ2hQLElBQUQsRUFBTztBQUNyQixVQUFJQSxJQUFJLENBQUM3USxNQUFMLElBQWUsQ0FBbkIsRUFDRSxPQUFPLEVBQVAsQ0FERixLQUdFLE9BQU82USxJQUFJLENBQUMsQ0FBRCxDQUFYO0FBQ0gsS0F0SnVDOztBQXdKeENpUCxtQkFBZSxDQUFDalAsSUFBRCxFQUFPO0FBQ3BCLFVBQUkzWSxJQUFJLEdBQUcsSUFBWDs7QUFDQSxVQUFJMlksSUFBSSxDQUFDN1EsTUFBTCxHQUFjLENBQWxCLEVBQXFCO0FBQ25CLGVBQU87QUFBRTRDLG1CQUFTLEVBQUUxSyxJQUFJLENBQUMwTTtBQUFsQixTQUFQO0FBQ0QsT0FGRCxNQUVPO0FBQ0xrTixhQUFLLENBQUNqQixJQUFJLENBQUMsQ0FBRCxDQUFMLEVBQVVrUCxLQUFLLENBQUNDLFFBQU4sQ0FBZUQsS0FBSyxDQUFDRSxlQUFOLENBQXNCO0FBQ2xEbGMsZ0JBQU0sRUFBRWdjLEtBQUssQ0FBQ0MsUUFBTixDQUFlRCxLQUFLLENBQUNHLEtBQU4sQ0FBWTNuQixNQUFaLEVBQW9CbkIsU0FBcEIsQ0FBZixDQUQwQztBQUVsRHdNLGNBQUksRUFBRW1jLEtBQUssQ0FBQ0MsUUFBTixDQUFlRCxLQUFLLENBQUNHLEtBQU4sQ0FBWTNuQixNQUFaLEVBQW9CMGIsS0FBcEIsRUFBMkJ6VixRQUEzQixFQUFxQ3BILFNBQXJDLENBQWYsQ0FGNEM7QUFHbERnSyxlQUFLLEVBQUUyZSxLQUFLLENBQUNDLFFBQU4sQ0FBZUQsS0FBSyxDQUFDRyxLQUFOLENBQVlDLE1BQVosRUFBb0Ivb0IsU0FBcEIsQ0FBZixDQUgyQztBQUlsRHlNLGNBQUksRUFBRWtjLEtBQUssQ0FBQ0MsUUFBTixDQUFlRCxLQUFLLENBQUNHLEtBQU4sQ0FBWUMsTUFBWixFQUFvQi9vQixTQUFwQixDQUFmO0FBSjRDLFNBQXRCLENBQWYsQ0FBVixDQUFMO0FBT0E7QUFDRXdMLG1CQUFTLEVBQUUxSyxJQUFJLENBQUMwTTtBQURsQixXQUVLaU0sSUFBSSxDQUFDLENBQUQsQ0FGVDtBQUlEO0FBQ0YsS0F6S3VDOztBQTJLeEM7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQXFCQTdQLFFBQUksR0FBVTtBQUFBLHdDQUFONlAsSUFBTTtBQUFOQSxZQUFNO0FBQUE7O0FBQ1o7QUFDQTtBQUNBO0FBQ0EsYUFBTyxLQUFLaU4sV0FBTCxDQUFpQjljLElBQWpCLENBQ0wsS0FBSzZlLGdCQUFMLENBQXNCaFAsSUFBdEIsQ0FESyxFQUVMLEtBQUtpUCxlQUFMLENBQXFCalAsSUFBckIsQ0FGSyxDQUFQO0FBSUQsS0F4TXVDOztBQTBNeEM7Ozs7Ozs7Ozs7Ozs7OztBQWVBMVAsV0FBTyxHQUFVO0FBQUEseUNBQU4wUCxJQUFNO0FBQU5BLFlBQU07QUFBQTs7QUFDZixhQUFPLEtBQUtpTixXQUFMLENBQWlCM2MsT0FBakIsQ0FDTCxLQUFLMGUsZ0JBQUwsQ0FBc0JoUCxJQUF0QixDQURLLEVBRUwsS0FBS2lQLGVBQUwsQ0FBcUJqUCxJQUFyQixDQUZLLENBQVA7QUFJRDs7QUE5TnVDLEdBQTFDO0FBaU9BdFksUUFBTSxDQUFDQyxNQUFQLENBQWM1QixLQUFLLENBQUNpTCxVQUFwQixFQUFnQztBQUM5QmdCLGtCQUFjLENBQUNtRSxNQUFELEVBQVNsRSxHQUFULEVBQWMzSCxVQUFkLEVBQTBCO0FBQ3RDLFVBQUk2TSxhQUFhLEdBQUdoQixNQUFNLENBQUM3RCxjQUFQLENBQXNCO0FBQ3hDeUcsYUFBSyxFQUFFLFVBQVU1TSxFQUFWLEVBQWMrRyxNQUFkLEVBQXNCO0FBQzNCakIsYUFBRyxDQUFDOEcsS0FBSixDQUFVek8sVUFBVixFQUFzQjZCLEVBQXRCLEVBQTBCK0csTUFBMUI7QUFDRCxTQUh1QztBQUl4Q2lVLGVBQU8sRUFBRSxVQUFVaGIsRUFBVixFQUFjK0csTUFBZCxFQUFzQjtBQUM3QmpCLGFBQUcsQ0FBQ2tWLE9BQUosQ0FBWTdjLFVBQVosRUFBd0I2QixFQUF4QixFQUE0QitHLE1BQTVCO0FBQ0QsU0FOdUM7QUFPeENzVCxlQUFPLEVBQUUsVUFBVXJhLEVBQVYsRUFBYztBQUNyQjhGLGFBQUcsQ0FBQ3VVLE9BQUosQ0FBWWxjLFVBQVosRUFBd0I2QixFQUF4QjtBQUNEO0FBVHVDLE9BQXRCLENBQXBCLENBRHNDLENBYXRDO0FBQ0E7QUFFQTs7QUFDQThGLFNBQUcsQ0FBQ2lGLE1BQUosQ0FBVyxZQUFZO0FBQ3JCQyxxQkFBYSxDQUFDbE4sSUFBZDtBQUNELE9BRkQsRUFqQnNDLENBcUJ0Qzs7QUFDQSxhQUFPa04sYUFBUDtBQUNELEtBeEI2Qjs7QUEwQjlCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQWxHLG9CQUFnQixDQUFDekUsUUFBRCxFQUFnQztBQUFBLFVBQXJCO0FBQUUraUI7QUFBRixPQUFxQix1RUFBSixFQUFJO0FBQzlDO0FBQ0EsVUFBSXRqQixlQUFlLENBQUN1akIsYUFBaEIsQ0FBOEJoakIsUUFBOUIsQ0FBSixFQUNFQSxRQUFRLEdBQUc7QUFBQ0osV0FBRyxFQUFFSTtBQUFOLE9BQVg7O0FBRUYsVUFBSTRXLEtBQUssQ0FBQ3plLE9BQU4sQ0FBYzZILFFBQWQsQ0FBSixFQUE2QjtBQUMzQjtBQUNBO0FBQ0EsY0FBTSxJQUFJekMsS0FBSixDQUFVLG1DQUFWLENBQU47QUFDRDs7QUFFRCxVQUFJLENBQUN5QyxRQUFELElBQWUsU0FBU0EsUUFBVixJQUF1QixDQUFDQSxRQUFRLENBQUNKLEdBQW5ELEVBQXlEO0FBQ3ZEO0FBQ0EsZUFBTztBQUFFQSxhQUFHLEVBQUVtakIsVUFBVSxJQUFJNUMsTUFBTSxDQUFDeGdCLEVBQVA7QUFBckIsU0FBUDtBQUNEOztBQUVELGFBQU9LLFFBQVA7QUFDRDs7QUFoRDZCLEdBQWhDO0FBbURBOUUsUUFBTSxDQUFDQyxNQUFQLENBQWM1QixLQUFLLENBQUNpTCxVQUFOLENBQWlCN0wsU0FBL0IsRUFBMEM7QUFDeEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTs7Ozs7Ozs7O0FBU0FrSCxVQUFNLENBQUNoRCxHQUFELEVBQU1DLFFBQU4sRUFBZ0I7QUFDcEI7QUFDQSxVQUFJLENBQUNELEdBQUwsRUFBVTtBQUNSLGNBQU0sSUFBSVUsS0FBSixDQUFVLDZCQUFWLENBQU47QUFDRCxPQUptQixDQU1wQjs7O0FBQ0FWLFNBQUcsR0FBRzNCLE1BQU0sQ0FBQ3VqQixNQUFQLENBQ0p2akIsTUFBTSxDQUFDK25CLGNBQVAsQ0FBc0JwbUIsR0FBdEIsQ0FESSxFQUVKM0IsTUFBTSxDQUFDZ29CLHlCQUFQLENBQWlDcm1CLEdBQWpDLENBRkksQ0FBTjs7QUFLQSxVQUFJLFNBQVNBLEdBQWIsRUFBa0I7QUFDaEIsWUFBSSxDQUFFQSxHQUFHLENBQUMrQyxHQUFOLElBQ0EsRUFBRyxPQUFPL0MsR0FBRyxDQUFDK0MsR0FBWCxLQUFtQixRQUFuQixJQUNBL0MsR0FBRyxDQUFDK0MsR0FBSixZQUFtQnJHLEtBQUssQ0FBQ0QsUUFENUIsQ0FESixFQUUyQztBQUN6QyxnQkFBTSxJQUFJaUUsS0FBSixDQUNKLDBFQURJLENBQU47QUFFRDtBQUNGLE9BUEQsTUFPTztBQUNMLFlBQUk0bEIsVUFBVSxHQUFHLElBQWpCLENBREssQ0FHTDtBQUNBO0FBQ0E7O0FBQ0EsWUFBSSxLQUFLQyxtQkFBTCxFQUFKLEVBQWdDO0FBQzlCLGdCQUFNQyxTQUFTLEdBQUdwRCxHQUFHLENBQUNxRCx3QkFBSixDQUE2QjdrQixHQUE3QixFQUFsQjs7QUFDQSxjQUFJLENBQUM0a0IsU0FBTCxFQUFnQjtBQUNkRixzQkFBVSxHQUFHLEtBQWI7QUFDRDtBQUNGOztBQUVELFlBQUlBLFVBQUosRUFBZ0I7QUFDZHRtQixhQUFHLENBQUMrQyxHQUFKLEdBQVUsS0FBS21nQixVQUFMLEVBQVY7QUFDRDtBQUNGLE9BbkNtQixDQXFDcEI7QUFDQTs7O0FBQ0EsVUFBSXdELHFDQUFxQyxHQUFHLFVBQVV0a0IsTUFBVixFQUFrQjtBQUM1RCxZQUFJcEMsR0FBRyxDQUFDK0MsR0FBUixFQUFhO0FBQ1gsaUJBQU8vQyxHQUFHLENBQUMrQyxHQUFYO0FBQ0QsU0FIMkQsQ0FLNUQ7QUFDQTtBQUNBOzs7QUFDQS9DLFdBQUcsQ0FBQytDLEdBQUosR0FBVVgsTUFBVjtBQUVBLGVBQU9BLE1BQVA7QUFDRCxPQVhEOztBQWFBLFlBQU1xQixlQUFlLEdBQUdrakIsWUFBWSxDQUNsQzFtQixRQURrQyxFQUN4QnltQixxQ0FEd0IsQ0FBcEM7O0FBR0EsVUFBSSxLQUFLSCxtQkFBTCxFQUFKLEVBQWdDO0FBQzlCLGNBQU1ua0IsTUFBTSxHQUFHLEtBQUt3a0Isa0JBQUwsQ0FBd0IsUUFBeEIsRUFBa0MsQ0FBQzVtQixHQUFELENBQWxDLEVBQXlDeUQsZUFBekMsQ0FBZjs7QUFDQSxlQUFPaWpCLHFDQUFxQyxDQUFDdGtCLE1BQUQsQ0FBNUM7QUFDRCxPQTFEbUIsQ0E0RHBCO0FBQ0E7OztBQUNBLFVBQUk7QUFDRjtBQUNBO0FBQ0E7QUFDQSxjQUFNQSxNQUFNLEdBQUcsS0FBS3doQixXQUFMLENBQWlCNWdCLE1BQWpCLENBQXdCaEQsR0FBeEIsRUFBNkJ5RCxlQUE3QixDQUFmOztBQUNBLGVBQU9pakIscUNBQXFDLENBQUN0a0IsTUFBRCxDQUE1QztBQUNELE9BTkQsQ0FNRSxPQUFPTSxDQUFQLEVBQVU7QUFDVixZQUFJekMsUUFBSixFQUFjO0FBQ1pBLGtCQUFRLENBQUN5QyxDQUFELENBQVI7QUFDQSxpQkFBTyxJQUFQO0FBQ0Q7O0FBQ0QsY0FBTUEsQ0FBTjtBQUNEO0FBQ0YsS0FuSHVDOztBQXFIeEM7Ozs7Ozs7Ozs7Ozs7QUFhQWdELFVBQU0sQ0FBQ3ZDLFFBQUQsRUFBV29lLFFBQVgsRUFBNEM7QUFBQSx5Q0FBcEJzRixrQkFBb0I7QUFBcEJBLDBCQUFvQjtBQUFBOztBQUNoRCxZQUFNNW1CLFFBQVEsR0FBRzZtQixtQkFBbUIsQ0FBQ0Qsa0JBQUQsQ0FBcEMsQ0FEZ0QsQ0FHaEQ7QUFDQTs7QUFDQSxZQUFNOW9CLE9BQU8scUJBQVM4b0Isa0JBQWtCLENBQUMsQ0FBRCxDQUFsQixJQUF5QixJQUFsQyxDQUFiOztBQUNBLFVBQUkxaEIsVUFBSjs7QUFDQSxVQUFJcEgsT0FBTyxJQUFJQSxPQUFPLENBQUN5RyxNQUF2QixFQUErQjtBQUM3QjtBQUNBLFlBQUl6RyxPQUFPLENBQUNvSCxVQUFaLEVBQXdCO0FBQ3RCLGNBQUksRUFBRSxPQUFPcEgsT0FBTyxDQUFDb0gsVUFBZixLQUE4QixRQUE5QixJQUEwQ3BILE9BQU8sQ0FBQ29ILFVBQVIsWUFBOEJ6SSxLQUFLLENBQUNELFFBQWhGLENBQUosRUFDRSxNQUFNLElBQUlpRSxLQUFKLENBQVUsdUNBQVYsQ0FBTjtBQUNGeUUsb0JBQVUsR0FBR3BILE9BQU8sQ0FBQ29ILFVBQXJCO0FBQ0QsU0FKRCxNQUlPLElBQUksQ0FBQ2hDLFFBQUQsSUFBYSxDQUFDQSxRQUFRLENBQUNKLEdBQTNCLEVBQWdDO0FBQ3JDb0Msb0JBQVUsR0FBRyxLQUFLK2QsVUFBTCxFQUFiO0FBQ0FubEIsaUJBQU8sQ0FBQ3FILFdBQVIsR0FBc0IsSUFBdEI7QUFDQXJILGlCQUFPLENBQUNvSCxVQUFSLEdBQXFCQSxVQUFyQjtBQUNEO0FBQ0Y7O0FBRURoQyxjQUFRLEdBQ056RyxLQUFLLENBQUNpTCxVQUFOLENBQWlCQyxnQkFBakIsQ0FBa0N6RSxRQUFsQyxFQUE0QztBQUFFK2lCLGtCQUFVLEVBQUUvZ0I7QUFBZCxPQUE1QyxDQURGO0FBR0EsWUFBTTFCLGVBQWUsR0FBR2tqQixZQUFZLENBQUMxbUIsUUFBRCxDQUFwQzs7QUFFQSxVQUFJLEtBQUtzbUIsbUJBQUwsRUFBSixFQUFnQztBQUM5QixjQUFNNVAsSUFBSSxHQUFHLENBQ1h4VCxRQURXLEVBRVhvZSxRQUZXLEVBR1h4akIsT0FIVyxDQUFiO0FBTUEsZUFBTyxLQUFLNm9CLGtCQUFMLENBQXdCLFFBQXhCLEVBQWtDalEsSUFBbEMsRUFBd0NsVCxlQUF4QyxDQUFQO0FBQ0QsT0FqQytDLENBbUNoRDtBQUNBOzs7QUFDQSxVQUFJO0FBQ0Y7QUFDQTtBQUNBO0FBQ0EsZUFBTyxLQUFLbWdCLFdBQUwsQ0FBaUJsZSxNQUFqQixDQUNMdkMsUUFESyxFQUNLb2UsUUFETCxFQUNleGpCLE9BRGYsRUFDd0IwRixlQUR4QixDQUFQO0FBRUQsT0FORCxDQU1FLE9BQU9mLENBQVAsRUFBVTtBQUNWLFlBQUl6QyxRQUFKLEVBQWM7QUFDWkEsa0JBQVEsQ0FBQ3lDLENBQUQsQ0FBUjtBQUNBLGlCQUFPLElBQVA7QUFDRDs7QUFDRCxjQUFNQSxDQUFOO0FBQ0Q7QUFDRixLQXBMdUM7O0FBc0x4Qzs7Ozs7Ozs7O0FBU0FtQixVQUFNLENBQUNWLFFBQUQsRUFBV2xELFFBQVgsRUFBcUI7QUFDekJrRCxjQUFRLEdBQUd6RyxLQUFLLENBQUNpTCxVQUFOLENBQWlCQyxnQkFBakIsQ0FBa0N6RSxRQUFsQyxDQUFYO0FBRUEsWUFBTU0sZUFBZSxHQUFHa2pCLFlBQVksQ0FBQzFtQixRQUFELENBQXBDOztBQUVBLFVBQUksS0FBS3NtQixtQkFBTCxFQUFKLEVBQWdDO0FBQzlCLGVBQU8sS0FBS0ssa0JBQUwsQ0FBd0IsUUFBeEIsRUFBa0MsQ0FBQ3pqQixRQUFELENBQWxDLEVBQThDTSxlQUE5QyxDQUFQO0FBQ0QsT0FQd0IsQ0FTekI7QUFDQTs7O0FBQ0EsVUFBSTtBQUNGO0FBQ0E7QUFDQTtBQUNBLGVBQU8sS0FBS21nQixXQUFMLENBQWlCL2YsTUFBakIsQ0FBd0JWLFFBQXhCLEVBQWtDTSxlQUFsQyxDQUFQO0FBQ0QsT0FMRCxDQUtFLE9BQU9mLENBQVAsRUFBVTtBQUNWLFlBQUl6QyxRQUFKLEVBQWM7QUFDWkEsa0JBQVEsQ0FBQ3lDLENBQUQsQ0FBUjtBQUNBLGlCQUFPLElBQVA7QUFDRDs7QUFDRCxjQUFNQSxDQUFOO0FBQ0Q7QUFDRixLQXROdUM7O0FBd054QztBQUNBO0FBQ0E2akIsdUJBQW1CLEdBQUc7QUFDcEI7QUFDQSxhQUFPLEtBQUs5QyxXQUFMLElBQW9CLEtBQUtBLFdBQUwsS0FBcUJsa0IsTUFBTSxDQUFDb2tCLE1BQXZEO0FBQ0QsS0E3TnVDOztBQStOeEM7Ozs7Ozs7Ozs7OztBQVlBbmYsVUFBTSxDQUFDckIsUUFBRCxFQUFXb2UsUUFBWCxFQUFxQnhqQixPQUFyQixFQUE4QmtDLFFBQTlCLEVBQXdDO0FBQzVDLFVBQUksQ0FBRUEsUUFBRixJQUFjLE9BQU9sQyxPQUFQLEtBQW1CLFVBQXJDLEVBQWlEO0FBQy9Da0MsZ0JBQVEsR0FBR2xDLE9BQVg7QUFDQUEsZUFBTyxHQUFHLEVBQVY7QUFDRDs7QUFFRCxhQUFPLEtBQUsySCxNQUFMLENBQVl2QyxRQUFaLEVBQXNCb2UsUUFBdEIsb0JBQ0Z4akIsT0FERTtBQUVMd0gscUJBQWEsRUFBRSxJQUZWO0FBR0xmLGNBQU0sRUFBRTtBQUhILFVBSUp2RSxRQUpJLENBQVA7QUFLRCxLQXRQdUM7O0FBd1B4QztBQUNBO0FBQ0FtSCxnQkFBWSxDQUFDQyxLQUFELEVBQVF0SixPQUFSLEVBQWlCO0FBQzNCLFVBQUlDLElBQUksR0FBRyxJQUFYO0FBQ0EsVUFBSSxDQUFDQSxJQUFJLENBQUM0bEIsV0FBTCxDQUFpQnhjLFlBQXRCLEVBQ0UsTUFBTSxJQUFJMUcsS0FBSixDQUFVLGtEQUFWLENBQU47O0FBQ0YxQyxVQUFJLENBQUM0bEIsV0FBTCxDQUFpQnhjLFlBQWpCLENBQThCQyxLQUE5QixFQUFxQ3RKLE9BQXJDO0FBQ0QsS0EvUHVDOztBQWlReEMwSixjQUFVLENBQUNKLEtBQUQsRUFBUTtBQUNoQixVQUFJckosSUFBSSxHQUFHLElBQVg7QUFDQSxVQUFJLENBQUNBLElBQUksQ0FBQzRsQixXQUFMLENBQWlCbmMsVUFBdEIsRUFDRSxNQUFNLElBQUkvRyxLQUFKLENBQVUsZ0RBQVYsQ0FBTjs7QUFDRjFDLFVBQUksQ0FBQzRsQixXQUFMLENBQWlCbmMsVUFBakIsQ0FBNEJKLEtBQTVCO0FBQ0QsS0F0UXVDOztBQXdReEN2RCxtQkFBZSxHQUFHO0FBQ2hCLFVBQUk5RixJQUFJLEdBQUcsSUFBWDtBQUNBLFVBQUksQ0FBQ0EsSUFBSSxDQUFDNGxCLFdBQUwsQ0FBaUI1ZixjQUF0QixFQUNFLE1BQU0sSUFBSXRELEtBQUosQ0FBVSxxREFBVixDQUFOOztBQUNGMUMsVUFBSSxDQUFDNGxCLFdBQUwsQ0FBaUI1ZixjQUFqQjtBQUNELEtBN1F1Qzs7QUErUXhDOUMsMkJBQXVCLENBQUNDLFFBQUQsRUFBV0MsWUFBWCxFQUF5QjtBQUM5QyxVQUFJcEQsSUFBSSxHQUFHLElBQVg7QUFDQSxVQUFJLENBQUNBLElBQUksQ0FBQzRsQixXQUFMLENBQWlCMWlCLHVCQUF0QixFQUNFLE1BQU0sSUFBSVIsS0FBSixDQUFVLDZEQUFWLENBQU47O0FBQ0YxQyxVQUFJLENBQUM0bEIsV0FBTCxDQUFpQjFpQix1QkFBakIsQ0FBeUNDLFFBQXpDLEVBQW1EQyxZQUFuRDtBQUNELEtBcFJ1Qzs7QUFzUnhDOzs7Ozs7QUFNQU4saUJBQWEsR0FBRztBQUNkLFVBQUk5QyxJQUFJLEdBQUcsSUFBWDs7QUFDQSxVQUFJLENBQUVBLElBQUksQ0FBQzRsQixXQUFMLENBQWlCOWlCLGFBQXZCLEVBQXNDO0FBQ3BDLGNBQU0sSUFBSUosS0FBSixDQUFVLG1EQUFWLENBQU47QUFDRDs7QUFDRCxhQUFPMUMsSUFBSSxDQUFDNGxCLFdBQUwsQ0FBaUI5aUIsYUFBakIsRUFBUDtBQUNELEtBbFN1Qzs7QUFvU3hDOzs7Ozs7QUFNQWltQixlQUFXLEdBQUc7QUFDWixVQUFJL29CLElBQUksR0FBRyxJQUFYOztBQUNBLFVBQUksRUFBR0EsSUFBSSxDQUFDZ2xCLE9BQUwsQ0FBYW5iLEtBQWIsSUFBc0I3SixJQUFJLENBQUNnbEIsT0FBTCxDQUFhbmIsS0FBYixDQUFtQjVJLEVBQTVDLENBQUosRUFBcUQ7QUFDbkQsY0FBTSxJQUFJeUIsS0FBSixDQUFVLGlEQUFWLENBQU47QUFDRDs7QUFDRCxhQUFPMUMsSUFBSSxDQUFDZ2xCLE9BQUwsQ0FBYW5iLEtBQWIsQ0FBbUI1SSxFQUExQjtBQUNEOztBQWhUdUMsR0FBMUMsRSxDQW1UQTs7QUFDQSxXQUFTMG5CLFlBQVQsQ0FBc0IxbUIsUUFBdEIsRUFBZ0MrbUIsYUFBaEMsRUFBK0M7QUFDN0MsV0FBTy9tQixRQUFRLElBQUksVUFBVXFGLEtBQVYsRUFBaUJsRCxNQUFqQixFQUF5QjtBQUMxQyxVQUFJa0QsS0FBSixFQUFXO0FBQ1RyRixnQkFBUSxDQUFDcUYsS0FBRCxDQUFSO0FBQ0QsT0FGRCxNQUVPLElBQUksT0FBTzBoQixhQUFQLEtBQXlCLFVBQTdCLEVBQXlDO0FBQzlDL21CLGdCQUFRLENBQUNxRixLQUFELEVBQVEwaEIsYUFBYSxDQUFDNWtCLE1BQUQsQ0FBckIsQ0FBUjtBQUNELE9BRk0sTUFFQTtBQUNMbkMsZ0JBQVEsQ0FBQ3FGLEtBQUQsRUFBUWxELE1BQVIsQ0FBUjtBQUNEO0FBQ0YsS0FSRDtBQVNEO0FBRUQ7Ozs7Ozs7O0FBTUExRixPQUFLLENBQUNELFFBQU4sR0FBaUJxb0IsT0FBTyxDQUFDcm9CLFFBQXpCO0FBRUE7Ozs7OztBQUtBQyxPQUFLLENBQUNxSyxNQUFOLEdBQWVuRSxlQUFlLENBQUNtRSxNQUEvQjtBQUVBOzs7O0FBR0FySyxPQUFLLENBQUNpTCxVQUFOLENBQWlCWixNQUFqQixHQUEwQnJLLEtBQUssQ0FBQ3FLLE1BQWhDO0FBRUE7Ozs7QUFHQXJLLE9BQUssQ0FBQ2lMLFVBQU4sQ0FBaUJsTCxRQUFqQixHQUE0QkMsS0FBSyxDQUFDRCxRQUFsQztBQUVBOzs7O0FBR0E4QyxRQUFNLENBQUNvSSxVQUFQLEdBQW9CakwsS0FBSyxDQUFDaUwsVUFBMUIsQyxDQUVBOztBQUNBdEosUUFBTSxDQUFDQyxNQUFQLENBQ0VpQixNQUFNLENBQUNvSSxVQUFQLENBQWtCN0wsU0FEcEIsRUFFRW1yQixTQUFTLENBQUNDLG1CQUZaOztBQUtBLFdBQVNKLG1CQUFULENBQTZCblEsSUFBN0IsRUFBbUM7QUFDakM7QUFDQTtBQUNBLFFBQUlBLElBQUksQ0FBQzdRLE1BQUwsS0FDQzZRLElBQUksQ0FBQ0EsSUFBSSxDQUFDN1EsTUFBTCxHQUFjLENBQWYsQ0FBSixLQUEwQjVJLFNBQTFCLElBQ0F5WixJQUFJLENBQUNBLElBQUksQ0FBQzdRLE1BQUwsR0FBYyxDQUFmLENBQUosWUFBaUN4QixRQUZsQyxDQUFKLEVBRWlEO0FBQy9DLGFBQU9xUyxJQUFJLENBQUNuQyxHQUFMLEVBQVA7QUFDRDtBQUNGOzs7Ozs7Ozs7Ozs7QUN6d0JEOzs7Ozs7QUFNQTlYLEtBQUssQ0FBQ3lxQixvQkFBTixHQUE2QixTQUFTQSxvQkFBVCxDQUErQnBwQixPQUEvQixFQUF3QztBQUNuRTZaLE9BQUssQ0FBQzdaLE9BQUQsRUFBVU0sTUFBVixDQUFMO0FBQ0EzQixPQUFLLENBQUNrQyxrQkFBTixHQUEyQmIsT0FBM0I7QUFDRCxDQUhELEMiLCJmaWxlIjoiL3BhY2thZ2VzL21vbmdvLmpzIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBQcm92aWRlIGEgc3luY2hyb25vdXMgQ29sbGVjdGlvbiBBUEkgdXNpbmcgZmliZXJzLCBiYWNrZWQgYnlcbiAqIE1vbmdvREIuICBUaGlzIGlzIG9ubHkgZm9yIHVzZSBvbiB0aGUgc2VydmVyLCBhbmQgbW9zdGx5IGlkZW50aWNhbFxuICogdG8gdGhlIGNsaWVudCBBUEkuXG4gKlxuICogTk9URTogdGhlIHB1YmxpYyBBUEkgbWV0aG9kcyBtdXN0IGJlIHJ1biB3aXRoaW4gYSBmaWJlci4gSWYgeW91IGNhbGxcbiAqIHRoZXNlIG91dHNpZGUgb2YgYSBmaWJlciB0aGV5IHdpbGwgZXhwbG9kZSFcbiAqL1xuXG52YXIgTW9uZ29EQiA9IE5wbU1vZHVsZU1vbmdvZGI7XG52YXIgRnV0dXJlID0gTnBtLnJlcXVpcmUoJ2ZpYmVycy9mdXR1cmUnKTtcbmltcG9ydCB7IERvY0ZldGNoZXIgfSBmcm9tIFwiLi9kb2NfZmV0Y2hlci5qc1wiO1xuXG5Nb25nb0ludGVybmFscyA9IHt9O1xuXG5Nb25nb0ludGVybmFscy5OcG1Nb2R1bGVzID0ge1xuICBtb25nb2RiOiB7XG4gICAgdmVyc2lvbjogTnBtTW9kdWxlTW9uZ29kYlZlcnNpb24sXG4gICAgbW9kdWxlOiBNb25nb0RCXG4gIH1cbn07XG5cbi8vIE9sZGVyIHZlcnNpb24gb2Ygd2hhdCBpcyBub3cgYXZhaWxhYmxlIHZpYVxuLy8gTW9uZ29JbnRlcm5hbHMuTnBtTW9kdWxlcy5tb25nb2RiLm1vZHVsZS4gIEl0IHdhcyBuZXZlciBkb2N1bWVudGVkLCBidXRcbi8vIHBlb3BsZSBkbyB1c2UgaXQuXG4vLyBYWFggQ09NUEFUIFdJVEggMS4wLjMuMlxuTW9uZ29JbnRlcm5hbHMuTnBtTW9kdWxlID0gTW9uZ29EQjtcblxuLy8gVGhpcyBpcyB1c2VkIHRvIGFkZCBvciByZW1vdmUgRUpTT04gZnJvbSB0aGUgYmVnaW5uaW5nIG9mIGV2ZXJ5dGhpbmcgbmVzdGVkXG4vLyBpbnNpZGUgYW4gRUpTT04gY3VzdG9tIHR5cGUuIEl0IHNob3VsZCBvbmx5IGJlIGNhbGxlZCBvbiBwdXJlIEpTT04hXG52YXIgcmVwbGFjZU5hbWVzID0gZnVuY3Rpb24gKGZpbHRlciwgdGhpbmcpIHtcbiAgaWYgKHR5cGVvZiB0aGluZyA9PT0gXCJvYmplY3RcIiAmJiB0aGluZyAhPT0gbnVsbCkge1xuICAgIGlmIChfLmlzQXJyYXkodGhpbmcpKSB7XG4gICAgICByZXR1cm4gXy5tYXAodGhpbmcsIF8uYmluZChyZXBsYWNlTmFtZXMsIG51bGwsIGZpbHRlcikpO1xuICAgIH1cbiAgICB2YXIgcmV0ID0ge307XG4gICAgXy5lYWNoKHRoaW5nLCBmdW5jdGlvbiAodmFsdWUsIGtleSkge1xuICAgICAgcmV0W2ZpbHRlcihrZXkpXSA9IHJlcGxhY2VOYW1lcyhmaWx0ZXIsIHZhbHVlKTtcbiAgICB9KTtcbiAgICByZXR1cm4gcmV0O1xuICB9XG4gIHJldHVybiB0aGluZztcbn07XG5cbi8vIEVuc3VyZSB0aGF0IEVKU09OLmNsb25lIGtlZXBzIGEgVGltZXN0YW1wIGFzIGEgVGltZXN0YW1wIChpbnN0ZWFkIG9mIGp1c3Rcbi8vIGRvaW5nIGEgc3RydWN0dXJhbCBjbG9uZSkuXG4vLyBYWFggaG93IG9rIGlzIHRoaXM/IHdoYXQgaWYgdGhlcmUgYXJlIG11bHRpcGxlIGNvcGllcyBvZiBNb25nb0RCIGxvYWRlZD9cbk1vbmdvREIuVGltZXN0YW1wLnByb3RvdHlwZS5jbG9uZSA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gVGltZXN0YW1wcyBzaG91bGQgYmUgaW1tdXRhYmxlLlxuICByZXR1cm4gdGhpcztcbn07XG5cbnZhciBtYWtlTW9uZ29MZWdhbCA9IGZ1bmN0aW9uIChuYW1lKSB7IHJldHVybiBcIkVKU09OXCIgKyBuYW1lOyB9O1xudmFyIHVubWFrZU1vbmdvTGVnYWwgPSBmdW5jdGlvbiAobmFtZSkgeyByZXR1cm4gbmFtZS5zdWJzdHIoNSk7IH07XG5cbnZhciByZXBsYWNlTW9uZ29BdG9tV2l0aE1ldGVvciA9IGZ1bmN0aW9uIChkb2N1bWVudCkge1xuICBpZiAoZG9jdW1lbnQgaW5zdGFuY2VvZiBNb25nb0RCLkJpbmFyeSkge1xuICAgIHZhciBidWZmZXIgPSBkb2N1bWVudC52YWx1ZSh0cnVlKTtcbiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYnVmZmVyKTtcbiAgfVxuICBpZiAoZG9jdW1lbnQgaW5zdGFuY2VvZiBNb25nb0RCLk9iamVjdElEKSB7XG4gICAgcmV0dXJuIG5ldyBNb25nby5PYmplY3RJRChkb2N1bWVudC50b0hleFN0cmluZygpKTtcbiAgfVxuICBpZiAoZG9jdW1lbnQgaW5zdGFuY2VvZiBNb25nb0RCLkRlY2ltYWwxMjgpIHtcbiAgICByZXR1cm4gRGVjaW1hbChkb2N1bWVudC50b1N0cmluZygpKTtcbiAgfVxuICBpZiAoZG9jdW1lbnRbXCJFSlNPTiR0eXBlXCJdICYmIGRvY3VtZW50W1wiRUpTT04kdmFsdWVcIl0gJiYgXy5zaXplKGRvY3VtZW50KSA9PT0gMikge1xuICAgIHJldHVybiBFSlNPTi5mcm9tSlNPTlZhbHVlKHJlcGxhY2VOYW1lcyh1bm1ha2VNb25nb0xlZ2FsLCBkb2N1bWVudCkpO1xuICB9XG4gIGlmIChkb2N1bWVudCBpbnN0YW5jZW9mIE1vbmdvREIuVGltZXN0YW1wKSB7XG4gICAgLy8gRm9yIG5vdywgdGhlIE1ldGVvciByZXByZXNlbnRhdGlvbiBvZiBhIE1vbmdvIHRpbWVzdGFtcCB0eXBlIChub3QgYSBkYXRlIVxuICAgIC8vIHRoaXMgaXMgYSB3ZWlyZCBpbnRlcm5hbCB0aGluZyB1c2VkIGluIHRoZSBvcGxvZyEpIGlzIHRoZSBzYW1lIGFzIHRoZVxuICAgIC8vIE1vbmdvIHJlcHJlc2VudGF0aW9uLiBXZSBuZWVkIHRvIGRvIHRoaXMgZXhwbGljaXRseSBvciBlbHNlIHdlIHdvdWxkIGRvIGFcbiAgICAvLyBzdHJ1Y3R1cmFsIGNsb25lIGFuZCBsb3NlIHRoZSBwcm90b3R5cGUuXG4gICAgcmV0dXJuIGRvY3VtZW50O1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59O1xuXG52YXIgcmVwbGFjZU1ldGVvckF0b21XaXRoTW9uZ28gPSBmdW5jdGlvbiAoZG9jdW1lbnQpIHtcbiAgaWYgKEVKU09OLmlzQmluYXJ5KGRvY3VtZW50KSkge1xuICAgIC8vIFRoaXMgZG9lcyBtb3JlIGNvcGllcyB0aGFuIHdlJ2QgbGlrZSwgYnV0IGlzIG5lY2Vzc2FyeSBiZWNhdXNlXG4gICAgLy8gTW9uZ29EQi5CU09OIG9ubHkgbG9va3MgbGlrZSBpdCB0YWtlcyBhIFVpbnQ4QXJyYXkgKGFuZCBkb2Vzbid0IGFjdHVhbGx5XG4gICAgLy8gc2VyaWFsaXplIGl0IGNvcnJlY3RseSkuXG4gICAgLy8gcmV0dXJuIG5ldyBNb25nb0RCLkJpbmFyeShCdWZmZXIuZnJvbShkb2N1bWVudCkpO1xuICB9XG4gIGlmIChkb2N1bWVudCBpbnN0YW5jZW9mIE1vbmdvLk9iamVjdElEKSB7XG4gICAgcmV0dXJuIG5ldyBNb25nb0RCLk9iamVjdElEKGRvY3VtZW50LnRvSGV4U3RyaW5nKCkpO1xuICB9XG4gIGlmIChkb2N1bWVudCBpbnN0YW5jZW9mIE1vbmdvREIuVGltZXN0YW1wKSB7XG4gICAgLy8gRm9yIG5vdywgdGhlIE1ldGVvciByZXByZXNlbnRhdGlvbiBvZiBhIE1vbmdvIHRpbWVzdGFtcCB0eXBlIChub3QgYSBkYXRlIVxuICAgIC8vIHRoaXMgaXMgYSB3ZWlyZCBpbnRlcm5hbCB0aGluZyB1c2VkIGluIHRoZSBvcGxvZyEpIGlzIHRoZSBzYW1lIGFzIHRoZVxuICAgIC8vIE1vbmdvIHJlcHJlc2VudGF0aW9uLiBXZSBuZWVkIHRvIGRvIHRoaXMgZXhwbGljaXRseSBvciBlbHNlIHdlIHdvdWxkIGRvIGFcbiAgICAvLyBzdHJ1Y3R1cmFsIGNsb25lIGFuZCBsb3NlIHRoZSBwcm90b3R5cGUuXG4gICAgcmV0dXJuIGRvY3VtZW50O1xuICB9XG4gIGlmIChkb2N1bWVudCBpbnN0YW5jZW9mIERlY2ltYWwpIHtcbiAgICByZXR1cm4gTW9uZ29EQi5EZWNpbWFsMTI4LmZyb21TdHJpbmcoZG9jdW1lbnQudG9TdHJpbmcoKSk7XG4gIH1cbiAgaWYgKEVKU09OLl9pc0N1c3RvbVR5cGUoZG9jdW1lbnQpKSB7XG4gICAgcmV0dXJuIHJlcGxhY2VOYW1lcyhtYWtlTW9uZ29MZWdhbCwgRUpTT04udG9KU09OVmFsdWUoZG9jdW1lbnQpKTtcbiAgfVxuICAvLyBJdCBpcyBub3Qgb3JkaW5hcmlseSBwb3NzaWJsZSB0byBzdGljayBkb2xsYXItc2lnbiBrZXlzIGludG8gbW9uZ29cbiAgLy8gc28gd2UgZG9uJ3QgYm90aGVyIGNoZWNraW5nIGZvciB0aGluZ3MgdGhhdCBuZWVkIGVzY2FwaW5nIGF0IHRoaXMgdGltZS5cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn07XG5cbnZhciByZXBsYWNlVHlwZXMgPSBmdW5jdGlvbiAoZG9jdW1lbnQsIGF0b21UcmFuc2Zvcm1lcikge1xuICBpZiAodHlwZW9mIGRvY3VtZW50ICE9PSAnb2JqZWN0JyB8fCBkb2N1bWVudCA9PT0gbnVsbClcbiAgICByZXR1cm4gZG9jdW1lbnQ7XG5cbiAgdmFyIHJlcGxhY2VkVG9wTGV2ZWxBdG9tID0gYXRvbVRyYW5zZm9ybWVyKGRvY3VtZW50KTtcbiAgaWYgKHJlcGxhY2VkVG9wTGV2ZWxBdG9tICE9PSB1bmRlZmluZWQpXG4gICAgcmV0dXJuIHJlcGxhY2VkVG9wTGV2ZWxBdG9tO1xuXG4gIHZhciByZXQgPSBkb2N1bWVudDtcbiAgXy5lYWNoKGRvY3VtZW50LCBmdW5jdGlvbiAodmFsLCBrZXkpIHtcbiAgICB2YXIgdmFsUmVwbGFjZWQgPSByZXBsYWNlVHlwZXModmFsLCBhdG9tVHJhbnNmb3JtZXIpO1xuICAgIGlmICh2YWwgIT09IHZhbFJlcGxhY2VkKSB7XG4gICAgICAvLyBMYXp5IGNsb25lLiBTaGFsbG93IGNvcHkuXG4gICAgICBpZiAocmV0ID09PSBkb2N1bWVudClcbiAgICAgICAgcmV0ID0gXy5jbG9uZShkb2N1bWVudCk7XG4gICAgICByZXRba2V5XSA9IHZhbFJlcGxhY2VkO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiByZXQ7XG59O1xuXG5cbk1vbmdvQ29ubmVjdGlvbiA9IGZ1bmN0aW9uICh1cmwsIG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgc2VsZi5fb2JzZXJ2ZU11bHRpcGxleGVycyA9IHt9O1xuICBzZWxmLl9vbkZhaWxvdmVySG9vayA9IG5ldyBIb29rO1xuXG4gIHZhciBtb25nb09wdGlvbnMgPSBPYmplY3QuYXNzaWduKHtcbiAgICAvLyBSZWNvbm5lY3Qgb24gZXJyb3IuXG4gICAgYXV0b1JlY29ubmVjdDogdHJ1ZSxcbiAgICAvLyBUcnkgdG8gcmVjb25uZWN0IGZvcmV2ZXIsIGluc3RlYWQgb2Ygc3RvcHBpbmcgYWZ0ZXIgMzAgdHJpZXMgKHRoZVxuICAgIC8vIGRlZmF1bHQpLCB3aXRoIGVhY2ggYXR0ZW1wdCBzZXBhcmF0ZWQgYnkgMTAwMG1zLlxuICAgIHJlY29ubmVjdFRyaWVzOiBJbmZpbml0eSxcbiAgICBpZ25vcmVVbmRlZmluZWQ6IHRydWUsXG4gICAgLy8gUmVxdWlyZWQgdG8gc2lsZW5jZSBkZXByZWNhdGlvbiB3YXJuaW5ncyB3aXRoIG1vbmdvZGJAMy4xLjEuXG4gICAgdXNlTmV3VXJsUGFyc2VyOiB0cnVlLFxuICB9LCBNb25nby5fY29ubmVjdGlvbk9wdGlvbnMpO1xuXG4gIC8vIERpc2FibGUgdGhlIG5hdGl2ZSBwYXJzZXIgYnkgZGVmYXVsdCwgdW5sZXNzIHNwZWNpZmljYWxseSBlbmFibGVkXG4gIC8vIGluIHRoZSBtb25nbyBVUkwuXG4gIC8vIC0gVGhlIG5hdGl2ZSBkcml2ZXIgY2FuIGNhdXNlIGVycm9ycyB3aGljaCBub3JtYWxseSB3b3VsZCBiZVxuICAvLyAgIHRocm93biwgY2F1Z2h0LCBhbmQgaGFuZGxlZCBpbnRvIHNlZ2ZhdWx0cyB0aGF0IHRha2UgZG93biB0aGVcbiAgLy8gICB3aG9sZSBhcHAuXG4gIC8vIC0gQmluYXJ5IG1vZHVsZXMgZG9uJ3QgeWV0IHdvcmsgd2hlbiB5b3UgYnVuZGxlIGFuZCBtb3ZlIHRoZSBidW5kbGVcbiAgLy8gICB0byBhIGRpZmZlcmVudCBwbGF0Zm9ybSAoYWthIGRlcGxveSlcbiAgLy8gV2Ugc2hvdWxkIHJldmlzaXQgdGhpcyBhZnRlciBiaW5hcnkgbnBtIG1vZHVsZSBzdXBwb3J0IGxhbmRzLlxuICBpZiAoISgvW1xcPyZdbmF0aXZlXz9bcFBdYXJzZXI9Ly50ZXN0KHVybCkpKSB7XG4gICAgbW9uZ29PcHRpb25zLm5hdGl2ZV9wYXJzZXIgPSBmYWxzZTtcbiAgfVxuXG4gIC8vIEludGVybmFsbHkgdGhlIG9wbG9nIGNvbm5lY3Rpb25zIHNwZWNpZnkgdGhlaXIgb3duIHBvb2xTaXplXG4gIC8vIHdoaWNoIHdlIGRvbid0IHdhbnQgdG8gb3ZlcndyaXRlIHdpdGggYW55IHVzZXIgZGVmaW5lZCB2YWx1ZVxuICBpZiAoXy5oYXMob3B0aW9ucywgJ3Bvb2xTaXplJykpIHtcbiAgICAvLyBJZiB3ZSBqdXN0IHNldCB0aGlzIGZvciBcInNlcnZlclwiLCByZXBsU2V0IHdpbGwgb3ZlcnJpZGUgaXQuIElmIHdlIGp1c3RcbiAgICAvLyBzZXQgaXQgZm9yIHJlcGxTZXQsIGl0IHdpbGwgYmUgaWdub3JlZCBpZiB3ZSdyZSBub3QgdXNpbmcgYSByZXBsU2V0LlxuICAgIG1vbmdvT3B0aW9ucy5wb29sU2l6ZSA9IG9wdGlvbnMucG9vbFNpemU7XG4gIH1cblxuICBzZWxmLmRiID0gbnVsbDtcbiAgLy8gV2Uga2VlcCB0cmFjayBvZiB0aGUgUmVwbFNldCdzIHByaW1hcnksIHNvIHRoYXQgd2UgY2FuIHRyaWdnZXIgaG9va3Mgd2hlblxuICAvLyBpdCBjaGFuZ2VzLiAgVGhlIE5vZGUgZHJpdmVyJ3Mgam9pbmVkIGNhbGxiYWNrIHNlZW1zIHRvIGZpcmUgd2F5IHRvb1xuICAvLyBvZnRlbiwgd2hpY2ggaXMgd2h5IHdlIG5lZWQgdG8gdHJhY2sgaXQgb3Vyc2VsdmVzLlxuICBzZWxmLl9wcmltYXJ5ID0gbnVsbDtcbiAgc2VsZi5fb3Bsb2dIYW5kbGUgPSBudWxsO1xuICBzZWxmLl9kb2NGZXRjaGVyID0gbnVsbDtcblxuXG4gIHZhciBjb25uZWN0RnV0dXJlID0gbmV3IEZ1dHVyZTtcbiAgTW9uZ29EQi5jb25uZWN0KFxuICAgIHVybCxcbiAgICBtb25nb09wdGlvbnMsXG4gICAgTWV0ZW9yLmJpbmRFbnZpcm9ubWVudChcbiAgICAgIGZ1bmN0aW9uIChlcnIsIGNsaWVudCkge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFyIGRiID0gY2xpZW50LmRiKCk7XG5cbiAgICAgICAgLy8gRmlyc3QsIGZpZ3VyZSBvdXQgd2hhdCB0aGUgY3VycmVudCBwcmltYXJ5IGlzLCBpZiBhbnkuXG4gICAgICAgIGlmIChkYi5zZXJ2ZXJDb25maWcuaXNNYXN0ZXJEb2MpIHtcbiAgICAgICAgICBzZWxmLl9wcmltYXJ5ID0gZGIuc2VydmVyQ29uZmlnLmlzTWFzdGVyRG9jLnByaW1hcnk7XG4gICAgICAgIH1cblxuICAgICAgICBkYi5zZXJ2ZXJDb25maWcub24oXG4gICAgICAgICAgJ2pvaW5lZCcsIE1ldGVvci5iaW5kRW52aXJvbm1lbnQoZnVuY3Rpb24gKGtpbmQsIGRvYykge1xuICAgICAgICAgICAgaWYgKGtpbmQgPT09ICdwcmltYXJ5Jykge1xuICAgICAgICAgICAgICBpZiAoZG9jLnByaW1hcnkgIT09IHNlbGYuX3ByaW1hcnkpIHtcbiAgICAgICAgICAgICAgICBzZWxmLl9wcmltYXJ5ID0gZG9jLnByaW1hcnk7XG4gICAgICAgICAgICAgICAgc2VsZi5fb25GYWlsb3Zlckhvb2suZWFjaChmdW5jdGlvbiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChkb2MubWUgPT09IHNlbGYuX3ByaW1hcnkpIHtcbiAgICAgICAgICAgICAgLy8gVGhlIHRoaW5nIHdlIHRob3VnaHQgd2FzIHByaW1hcnkgaXMgbm93IHNvbWV0aGluZyBvdGhlciB0aGFuXG4gICAgICAgICAgICAgIC8vIHByaW1hcnkuICBGb3JnZXQgdGhhdCB3ZSB0aG91Z2h0IGl0IHdhcyBwcmltYXJ5LiAgKFRoaXMgbWVhbnNcbiAgICAgICAgICAgICAgLy8gdGhhdCBpZiBhIHNlcnZlciBzdG9wcyBiZWluZyBwcmltYXJ5IGFuZCB0aGVuIHN0YXJ0cyBiZWluZ1xuICAgICAgICAgICAgICAvLyBwcmltYXJ5IGFnYWluIHdpdGhvdXQgYW5vdGhlciBzZXJ2ZXIgYmVjb21pbmcgcHJpbWFyeSBpbiB0aGVcbiAgICAgICAgICAgICAgLy8gbWlkZGxlLCB3ZSdsbCBjb3JyZWN0bHkgY291bnQgaXQgYXMgYSBmYWlsb3Zlci4pXG4gICAgICAgICAgICAgIHNlbGYuX3ByaW1hcnkgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pKTtcblxuICAgICAgICAvLyBBbGxvdyB0aGUgY29uc3RydWN0b3IgdG8gcmV0dXJuLlxuICAgICAgICBjb25uZWN0RnV0dXJlWydyZXR1cm4nXSh7IGNsaWVudCwgZGIgfSk7XG4gICAgICB9LFxuICAgICAgY29ubmVjdEZ1dHVyZS5yZXNvbHZlcigpICAvLyBvbkV4Y2VwdGlvblxuICAgIClcbiAgKTtcblxuICAvLyBXYWl0IGZvciB0aGUgY29ubmVjdGlvbiB0byBiZSBzdWNjZXNzZnVsICh0aHJvd3Mgb24gZmFpbHVyZSkgYW5kIGFzc2lnbiB0aGVcbiAgLy8gcmVzdWx0cyAoYGNsaWVudGAgYW5kIGBkYmApIHRvIGBzZWxmYC5cbiAgT2JqZWN0LmFzc2lnbihzZWxmLCBjb25uZWN0RnV0dXJlLndhaXQoKSk7XG5cbiAgaWYgKG9wdGlvbnMub3Bsb2dVcmwgJiYgISBQYWNrYWdlWydkaXNhYmxlLW9wbG9nJ10pIHtcbiAgICBzZWxmLl9vcGxvZ0hhbmRsZSA9IG5ldyBPcGxvZ0hhbmRsZShvcHRpb25zLm9wbG9nVXJsLCBzZWxmLmRiLmRhdGFiYXNlTmFtZSk7XG4gICAgc2VsZi5fZG9jRmV0Y2hlciA9IG5ldyBEb2NGZXRjaGVyKHNlbGYpO1xuICB9XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLmNsb3NlID0gZnVuY3Rpb24oKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICBpZiAoISBzZWxmLmRiKVxuICAgIHRocm93IEVycm9yKFwiY2xvc2UgY2FsbGVkIGJlZm9yZSBDb25uZWN0aW9uIGNyZWF0ZWQ/XCIpO1xuXG4gIC8vIFhYWCBwcm9iYWJseSB1bnRlc3RlZFxuICB2YXIgb3Bsb2dIYW5kbGUgPSBzZWxmLl9vcGxvZ0hhbmRsZTtcbiAgc2VsZi5fb3Bsb2dIYW5kbGUgPSBudWxsO1xuICBpZiAob3Bsb2dIYW5kbGUpXG4gICAgb3Bsb2dIYW5kbGUuc3RvcCgpO1xuXG4gIC8vIFVzZSBGdXR1cmUud3JhcCBzbyB0aGF0IGVycm9ycyBnZXQgdGhyb3duLiBUaGlzIGhhcHBlbnMgdG9cbiAgLy8gd29yayBldmVuIG91dHNpZGUgYSBmaWJlciBzaW5jZSB0aGUgJ2Nsb3NlJyBtZXRob2QgaXMgbm90XG4gIC8vIGFjdHVhbGx5IGFzeW5jaHJvbm91cy5cbiAgRnV0dXJlLndyYXAoXy5iaW5kKHNlbGYuY2xpZW50LmNsb3NlLCBzZWxmLmNsaWVudCkpKHRydWUpLndhaXQoKTtcbn07XG5cbi8vIFJldHVybnMgdGhlIE1vbmdvIENvbGxlY3Rpb24gb2JqZWN0OyBtYXkgeWllbGQuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLnJhd0NvbGxlY3Rpb24gPSBmdW5jdGlvbiAoY29sbGVjdGlvbk5hbWUpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIGlmICghIHNlbGYuZGIpXG4gICAgdGhyb3cgRXJyb3IoXCJyYXdDb2xsZWN0aW9uIGNhbGxlZCBiZWZvcmUgQ29ubmVjdGlvbiBjcmVhdGVkP1wiKTtcblxuICB2YXIgZnV0dXJlID0gbmV3IEZ1dHVyZTtcbiAgc2VsZi5kYi5jb2xsZWN0aW9uKGNvbGxlY3Rpb25OYW1lLCBmdXR1cmUucmVzb2x2ZXIoKSk7XG4gIHJldHVybiBmdXR1cmUud2FpdCgpO1xufTtcblxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5fY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbiA9IGZ1bmN0aW9uIChcbiAgICBjb2xsZWN0aW9uTmFtZSwgYnl0ZVNpemUsIG1heERvY3VtZW50cykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKCEgc2VsZi5kYilcbiAgICB0aHJvdyBFcnJvcihcIl9jcmVhdGVDYXBwZWRDb2xsZWN0aW9uIGNhbGxlZCBiZWZvcmUgQ29ubmVjdGlvbiBjcmVhdGVkP1wiKTtcblxuICB2YXIgZnV0dXJlID0gbmV3IEZ1dHVyZSgpO1xuICBzZWxmLmRiLmNyZWF0ZUNvbGxlY3Rpb24oXG4gICAgY29sbGVjdGlvbk5hbWUsXG4gICAgeyBjYXBwZWQ6IHRydWUsIHNpemU6IGJ5dGVTaXplLCBtYXg6IG1heERvY3VtZW50cyB9LFxuICAgIGZ1dHVyZS5yZXNvbHZlcigpKTtcbiAgZnV0dXJlLndhaXQoKTtcbn07XG5cbi8vIFRoaXMgc2hvdWxkIGJlIGNhbGxlZCBzeW5jaHJvbm91c2x5IHdpdGggYSB3cml0ZSwgdG8gY3JlYXRlIGFcbi8vIHRyYW5zYWN0aW9uIG9uIHRoZSBjdXJyZW50IHdyaXRlIGZlbmNlLCBpZiBhbnkuIEFmdGVyIHdlIGNhbiByZWFkXG4vLyB0aGUgd3JpdGUsIGFuZCBhZnRlciBvYnNlcnZlcnMgaGF2ZSBiZWVuIG5vdGlmaWVkIChvciBhdCBsZWFzdCxcbi8vIGFmdGVyIHRoZSBvYnNlcnZlciBub3RpZmllcnMgaGF2ZSBhZGRlZCB0aGVtc2VsdmVzIHRvIHRoZSB3cml0ZVxuLy8gZmVuY2UpLCB5b3Ugc2hvdWxkIGNhbGwgJ2NvbW1pdHRlZCgpJyBvbiB0aGUgb2JqZWN0IHJldHVybmVkLlxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5fbWF5YmVCZWdpbldyaXRlID0gZnVuY3Rpb24gKCkge1xuICB2YXIgZmVuY2UgPSBERFBTZXJ2ZXIuX0N1cnJlbnRXcml0ZUZlbmNlLmdldCgpO1xuICBpZiAoZmVuY2UpIHtcbiAgICByZXR1cm4gZmVuY2UuYmVnaW5Xcml0ZSgpO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiB7Y29tbWl0dGVkOiBmdW5jdGlvbiAoKSB7fX07XG4gIH1cbn07XG5cbi8vIEludGVybmFsIGludGVyZmFjZTogYWRkcyBhIGNhbGxiYWNrIHdoaWNoIGlzIGNhbGxlZCB3aGVuIHRoZSBNb25nbyBwcmltYXJ5XG4vLyBjaGFuZ2VzLiBSZXR1cm5zIGEgc3RvcCBoYW5kbGUuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9vbkZhaWxvdmVyID0gZnVuY3Rpb24gKGNhbGxiYWNrKSB7XG4gIHJldHVybiB0aGlzLl9vbkZhaWxvdmVySG9vay5yZWdpc3RlcihjYWxsYmFjayk7XG59O1xuXG5cbi8vLy8vLy8vLy8vLyBQdWJsaWMgQVBJIC8vLy8vLy8vLy9cblxuLy8gVGhlIHdyaXRlIG1ldGhvZHMgYmxvY2sgdW50aWwgdGhlIGRhdGFiYXNlIGhhcyBjb25maXJtZWQgdGhlIHdyaXRlIChpdCBtYXlcbi8vIG5vdCBiZSByZXBsaWNhdGVkIG9yIHN0YWJsZSBvbiBkaXNrLCBidXQgb25lIHNlcnZlciBoYXMgY29uZmlybWVkIGl0KSBpZiBub1xuLy8gY2FsbGJhY2sgaXMgcHJvdmlkZWQuIElmIGEgY2FsbGJhY2sgaXMgcHJvdmlkZWQsIHRoZW4gdGhleSBjYWxsIHRoZSBjYWxsYmFja1xuLy8gd2hlbiB0aGUgd3JpdGUgaXMgY29uZmlybWVkLiBUaGV5IHJldHVybiBub3RoaW5nIG9uIHN1Y2Nlc3MsIGFuZCByYWlzZSBhblxuLy8gZXhjZXB0aW9uIG9uIGZhaWx1cmUuXG4vL1xuLy8gQWZ0ZXIgbWFraW5nIGEgd3JpdGUgKHdpdGggaW5zZXJ0LCB1cGRhdGUsIHJlbW92ZSksIG9ic2VydmVycyBhcmVcbi8vIG5vdGlmaWVkIGFzeW5jaHJvbm91c2x5LiBJZiB5b3Ugd2FudCB0byByZWNlaXZlIGEgY2FsbGJhY2sgb25jZSBhbGxcbi8vIG9mIHRoZSBvYnNlcnZlciBub3RpZmljYXRpb25zIGhhdmUgbGFuZGVkIGZvciB5b3VyIHdyaXRlLCBkbyB0aGVcbi8vIHdyaXRlcyBpbnNpZGUgYSB3cml0ZSBmZW5jZSAoc2V0IEREUFNlcnZlci5fQ3VycmVudFdyaXRlRmVuY2UgdG8gYSBuZXdcbi8vIF9Xcml0ZUZlbmNlLCBhbmQgdGhlbiBzZXQgYSBjYWxsYmFjayBvbiB0aGUgd3JpdGUgZmVuY2UuKVxuLy9cbi8vIFNpbmNlIG91ciBleGVjdXRpb24gZW52aXJvbm1lbnQgaXMgc2luZ2xlLXRocmVhZGVkLCB0aGlzIGlzXG4vLyB3ZWxsLWRlZmluZWQgLS0gYSB3cml0ZSBcImhhcyBiZWVuIG1hZGVcIiBpZiBpdCdzIHJldHVybmVkLCBhbmQgYW5cbi8vIG9ic2VydmVyIFwiaGFzIGJlZW4gbm90aWZpZWRcIiBpZiBpdHMgY2FsbGJhY2sgaGFzIHJldHVybmVkLlxuXG52YXIgd3JpdGVDYWxsYmFjayA9IGZ1bmN0aW9uICh3cml0ZSwgcmVmcmVzaCwgY2FsbGJhY2spIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIChlcnIsIHJlc3VsdCkge1xuICAgIGlmICghIGVycikge1xuICAgICAgLy8gWFhYIFdlIGRvbid0IGhhdmUgdG8gcnVuIHRoaXMgb24gZXJyb3IsIHJpZ2h0P1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVmcmVzaCgpO1xuICAgICAgfSBjYXRjaCAocmVmcmVzaEVycikge1xuICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICBjYWxsYmFjayhyZWZyZXNoRXJyKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgcmVmcmVzaEVycjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICB3cml0ZS5jb21taXR0ZWQoKTtcbiAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgIGNhbGxiYWNrKGVyciwgcmVzdWx0KTtcbiAgICB9IGVsc2UgaWYgKGVycikge1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgfTtcbn07XG5cbnZhciBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZSA9IGZ1bmN0aW9uIChjYWxsYmFjaykge1xuICByZXR1cm4gTWV0ZW9yLmJpbmRFbnZpcm9ubWVudChjYWxsYmFjaywgXCJNb25nbyB3cml0ZVwiKTtcbn07XG5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX2luc2VydCA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uX25hbWUsIGRvY3VtZW50LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICB2YXIgc2VuZEVycm9yID0gZnVuY3Rpb24gKGUpIHtcbiAgICBpZiAoY2FsbGJhY2spXG4gICAgICByZXR1cm4gY2FsbGJhY2soZSk7XG4gICAgdGhyb3cgZTtcbiAgfTtcblxuICBpZiAoY29sbGVjdGlvbl9uYW1lID09PSBcIl9fX21ldGVvcl9mYWlsdXJlX3Rlc3RfY29sbGVjdGlvblwiKSB7XG4gICAgdmFyIGUgPSBuZXcgRXJyb3IoXCJGYWlsdXJlIHRlc3RcIik7XG4gICAgZS5fZXhwZWN0ZWRCeVRlc3QgPSB0cnVlO1xuICAgIHNlbmRFcnJvcihlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIShMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QoZG9jdW1lbnQpICYmXG4gICAgICAgICFFSlNPTi5faXNDdXN0b21UeXBlKGRvY3VtZW50KSkpIHtcbiAgICBzZW5kRXJyb3IobmV3IEVycm9yKFxuICAgICAgXCJPbmx5IHBsYWluIG9iamVjdHMgbWF5IGJlIGluc2VydGVkIGludG8gTW9uZ29EQlwiKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIHdyaXRlID0gc2VsZi5fbWF5YmVCZWdpbldyaXRlKCk7XG4gIHZhciByZWZyZXNoID0gZnVuY3Rpb24gKCkge1xuICAgIE1ldGVvci5yZWZyZXNoKHtjb2xsZWN0aW9uOiBjb2xsZWN0aW9uX25hbWUsIGlkOiBkb2N1bWVudC5faWQgfSk7XG4gIH07XG4gIGNhbGxiYWNrID0gYmluZEVudmlyb25tZW50Rm9yV3JpdGUod3JpdGVDYWxsYmFjayh3cml0ZSwgcmVmcmVzaCwgY2FsbGJhY2spKTtcbiAgdHJ5IHtcbiAgICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjb2xsZWN0aW9uX25hbWUpO1xuICAgIGNvbGxlY3Rpb24uaW5zZXJ0KHJlcGxhY2VUeXBlcyhkb2N1bWVudCwgcmVwbGFjZU1ldGVvckF0b21XaXRoTW9uZ28pLFxuICAgICAgICAgICAgICAgICAgICAgIHtzYWZlOiB0cnVlfSwgY2FsbGJhY2spO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB3cml0ZS5jb21taXR0ZWQoKTtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbn07XG5cbi8vIENhdXNlIHF1ZXJpZXMgdGhhdCBtYXkgYmUgYWZmZWN0ZWQgYnkgdGhlIHNlbGVjdG9yIHRvIHBvbGwgaW4gdGhpcyB3cml0ZVxuLy8gZmVuY2UuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9yZWZyZXNoID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBzZWxlY3Rvcikge1xuICB2YXIgcmVmcmVzaEtleSA9IHtjb2xsZWN0aW9uOiBjb2xsZWN0aW9uTmFtZX07XG4gIC8vIElmIHdlIGtub3cgd2hpY2ggZG9jdW1lbnRzIHdlJ3JlIHJlbW92aW5nLCBkb24ndCBwb2xsIHF1ZXJpZXMgdGhhdCBhcmVcbiAgLy8gc3BlY2lmaWMgdG8gb3RoZXIgZG9jdW1lbnRzLiAoTm90ZSB0aGF0IG11bHRpcGxlIG5vdGlmaWNhdGlvbnMgaGVyZSBzaG91bGRcbiAgLy8gbm90IGNhdXNlIG11bHRpcGxlIHBvbGxzLCBzaW5jZSBhbGwgb3VyIGxpc3RlbmVyIGlzIGRvaW5nIGlzIGVucXVldWVpbmcgYVxuICAvLyBwb2xsLilcbiAgdmFyIHNwZWNpZmljSWRzID0gTG9jYWxDb2xsZWN0aW9uLl9pZHNNYXRjaGVkQnlTZWxlY3RvcihzZWxlY3Rvcik7XG4gIGlmIChzcGVjaWZpY0lkcykge1xuICAgIF8uZWFjaChzcGVjaWZpY0lkcywgZnVuY3Rpb24gKGlkKSB7XG4gICAgICBNZXRlb3IucmVmcmVzaChfLmV4dGVuZCh7aWQ6IGlkfSwgcmVmcmVzaEtleSkpO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIE1ldGVvci5yZWZyZXNoKHJlZnJlc2hLZXkpO1xuICB9XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9yZW1vdmUgPSBmdW5jdGlvbiAoY29sbGVjdGlvbl9uYW1lLCBzZWxlY3RvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKGNvbGxlY3Rpb25fbmFtZSA9PT0gXCJfX19tZXRlb3JfZmFpbHVyZV90ZXN0X2NvbGxlY3Rpb25cIikge1xuICAgIHZhciBlID0gbmV3IEVycm9yKFwiRmFpbHVyZSB0ZXN0XCIpO1xuICAgIGUuX2V4cGVjdGVkQnlUZXN0ID0gdHJ1ZTtcbiAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgIHJldHVybiBjYWxsYmFjayhlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH1cblxuICB2YXIgd3JpdGUgPSBzZWxmLl9tYXliZUJlZ2luV3JpdGUoKTtcbiAgdmFyIHJlZnJlc2ggPSBmdW5jdGlvbiAoKSB7XG4gICAgc2VsZi5fcmVmcmVzaChjb2xsZWN0aW9uX25hbWUsIHNlbGVjdG9yKTtcbiAgfTtcbiAgY2FsbGJhY2sgPSBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZSh3cml0ZUNhbGxiYWNrKHdyaXRlLCByZWZyZXNoLCBjYWxsYmFjaykpO1xuXG4gIHRyeSB7XG4gICAgdmFyIGNvbGxlY3Rpb24gPSBzZWxmLnJhd0NvbGxlY3Rpb24oY29sbGVjdGlvbl9uYW1lKTtcbiAgICB2YXIgd3JhcHBlZENhbGxiYWNrID0gZnVuY3Rpb24oZXJyLCBkcml2ZXJSZXN1bHQpIHtcbiAgICAgIGNhbGxiYWNrKGVyciwgdHJhbnNmb3JtUmVzdWx0KGRyaXZlclJlc3VsdCkubnVtYmVyQWZmZWN0ZWQpO1xuICAgIH07XG4gICAgY29sbGVjdGlvbi5yZW1vdmUocmVwbGFjZVR5cGVzKHNlbGVjdG9yLCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyksXG4gICAgICAgICAgICAgICAgICAgICAgIHtzYWZlOiB0cnVlfSwgd3JhcHBlZENhbGxiYWNrKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgd3JpdGUuY29tbWl0dGVkKCk7XG4gICAgdGhyb3cgZXJyO1xuICB9XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9kcm9wQ29sbGVjdGlvbiA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSwgY2IpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIHZhciB3cml0ZSA9IHNlbGYuX21heWJlQmVnaW5Xcml0ZSgpO1xuICB2YXIgcmVmcmVzaCA9IGZ1bmN0aW9uICgpIHtcbiAgICBNZXRlb3IucmVmcmVzaCh7Y29sbGVjdGlvbjogY29sbGVjdGlvbk5hbWUsIGlkOiBudWxsLFxuICAgICAgICAgICAgICAgICAgICBkcm9wQ29sbGVjdGlvbjogdHJ1ZX0pO1xuICB9O1xuICBjYiA9IGJpbmRFbnZpcm9ubWVudEZvcldyaXRlKHdyaXRlQ2FsbGJhY2sod3JpdGUsIHJlZnJlc2gsIGNiKSk7XG5cbiAgdHJ5IHtcbiAgICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjb2xsZWN0aW9uTmFtZSk7XG4gICAgY29sbGVjdGlvbi5kcm9wKGNiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHdyaXRlLmNvbW1pdHRlZCgpO1xuICAgIHRocm93IGU7XG4gIH1cbn07XG5cbi8vIEZvciB0ZXN0aW5nIG9ubHkuICBTbGlnaHRseSBiZXR0ZXIgdGhhbiBgYy5yYXdEYXRhYmFzZSgpLmRyb3BEYXRhYmFzZSgpYFxuLy8gYmVjYXVzZSBpdCBsZXRzIHRoZSB0ZXN0J3MgZmVuY2Ugd2FpdCBmb3IgaXQgdG8gYmUgY29tcGxldGUuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9kcm9wRGF0YWJhc2UgPSBmdW5jdGlvbiAoY2IpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIHZhciB3cml0ZSA9IHNlbGYuX21heWJlQmVnaW5Xcml0ZSgpO1xuICB2YXIgcmVmcmVzaCA9IGZ1bmN0aW9uICgpIHtcbiAgICBNZXRlb3IucmVmcmVzaCh7IGRyb3BEYXRhYmFzZTogdHJ1ZSB9KTtcbiAgfTtcbiAgY2IgPSBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZSh3cml0ZUNhbGxiYWNrKHdyaXRlLCByZWZyZXNoLCBjYikpO1xuXG4gIHRyeSB7XG4gICAgc2VsZi5kYi5kcm9wRGF0YWJhc2UoY2IpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgd3JpdGUuY29tbWl0dGVkKCk7XG4gICAgdGhyb3cgZTtcbiAgfVxufTtcblxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5fdXBkYXRlID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25fbmFtZSwgc2VsZWN0b3IsIG1vZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zLCBjYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKCEgY2FsbGJhY2sgJiYgb3B0aW9ucyBpbnN0YW5jZW9mIEZ1bmN0aW9uKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSBudWxsO1xuICB9XG5cbiAgaWYgKGNvbGxlY3Rpb25fbmFtZSA9PT0gXCJfX19tZXRlb3JfZmFpbHVyZV90ZXN0X2NvbGxlY3Rpb25cIikge1xuICAgIHZhciBlID0gbmV3IEVycm9yKFwiRmFpbHVyZSB0ZXN0XCIpO1xuICAgIGUuX2V4cGVjdGVkQnlUZXN0ID0gdHJ1ZTtcbiAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgIHJldHVybiBjYWxsYmFjayhlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH1cblxuICAvLyBleHBsaWNpdCBzYWZldHkgY2hlY2suIG51bGwgYW5kIHVuZGVmaW5lZCBjYW4gY3Jhc2ggdGhlIG1vbmdvXG4gIC8vIGRyaXZlci4gQWx0aG91Z2ggdGhlIG5vZGUgZHJpdmVyIGFuZCBtaW5pbW9uZ28gZG8gJ3N1cHBvcnQnXG4gIC8vIG5vbi1vYmplY3QgbW9kaWZpZXIgaW4gdGhhdCB0aGV5IGRvbid0IGNyYXNoLCB0aGV5IGFyZSBub3RcbiAgLy8gbWVhbmluZ2Z1bCBvcGVyYXRpb25zIGFuZCBkbyBub3QgZG8gYW55dGhpbmcuIERlZmVuc2l2ZWx5IHRocm93IGFuXG4gIC8vIGVycm9yIGhlcmUuXG4gIGlmICghbW9kIHx8IHR5cGVvZiBtb2QgIT09ICdvYmplY3QnKVxuICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbW9kaWZpZXIuIE1vZGlmaWVyIG11c3QgYmUgYW4gb2JqZWN0LlwiKTtcblxuICBpZiAoIShMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QobW9kKSAmJlxuICAgICAgICAhRUpTT04uX2lzQ3VzdG9tVHlwZShtb2QpKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiT25seSBwbGFpbiBvYmplY3RzIG1heSBiZSB1c2VkIGFzIHJlcGxhY2VtZW50XCIgK1xuICAgICAgICBcIiBkb2N1bWVudHMgaW4gTW9uZ29EQlwiKTtcbiAgfVxuXG4gIGlmICghb3B0aW9ucykgb3B0aW9ucyA9IHt9O1xuXG4gIHZhciB3cml0ZSA9IHNlbGYuX21heWJlQmVnaW5Xcml0ZSgpO1xuICB2YXIgcmVmcmVzaCA9IGZ1bmN0aW9uICgpIHtcbiAgICBzZWxmLl9yZWZyZXNoKGNvbGxlY3Rpb25fbmFtZSwgc2VsZWN0b3IpO1xuICB9O1xuICBjYWxsYmFjayA9IHdyaXRlQ2FsbGJhY2sod3JpdGUsIHJlZnJlc2gsIGNhbGxiYWNrKTtcbiAgdHJ5IHtcbiAgICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjb2xsZWN0aW9uX25hbWUpO1xuICAgIHZhciBtb25nb09wdHMgPSB7c2FmZTogdHJ1ZX07XG4gICAgLy8gZXhwbGljdGx5IGVudW1lcmF0ZSBvcHRpb25zIHRoYXQgbWluaW1vbmdvIHN1cHBvcnRzXG4gICAgaWYgKG9wdGlvbnMudXBzZXJ0KSBtb25nb09wdHMudXBzZXJ0ID0gdHJ1ZTtcbiAgICBpZiAob3B0aW9ucy5tdWx0aSkgbW9uZ29PcHRzLm11bHRpID0gdHJ1ZTtcbiAgICAvLyBMZXRzIHlvdSBnZXQgYSBtb3JlIG1vcmUgZnVsbCByZXN1bHQgZnJvbSBNb25nb0RCLiBVc2Ugd2l0aCBjYXV0aW9uOlxuICAgIC8vIG1pZ2h0IG5vdCB3b3JrIHdpdGggQy51cHNlcnQgKGFzIG9wcG9zZWQgdG8gQy51cGRhdGUoe3Vwc2VydDp0cnVlfSkgb3JcbiAgICAvLyB3aXRoIHNpbXVsYXRlZCB1cHNlcnQuXG4gICAgaWYgKG9wdGlvbnMuZnVsbFJlc3VsdCkgbW9uZ29PcHRzLmZ1bGxSZXN1bHQgPSB0cnVlO1xuXG4gICAgdmFyIG1vbmdvU2VsZWN0b3IgPSByZXBsYWNlVHlwZXMoc2VsZWN0b3IsIHJlcGxhY2VNZXRlb3JBdG9tV2l0aE1vbmdvKTtcbiAgICB2YXIgbW9uZ29Nb2QgPSByZXBsYWNlVHlwZXMobW9kLCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyk7XG5cbiAgICB2YXIgaXNNb2RpZnkgPSBMb2NhbENvbGxlY3Rpb24uX2lzTW9kaWZpY2F0aW9uTW9kKG1vbmdvTW9kKTtcblxuICAgIGlmIChvcHRpb25zLl9mb3JiaWRSZXBsYWNlICYmICFpc01vZGlmeSkge1xuICAgICAgdmFyIGVyciA9IG5ldyBFcnJvcihcIkludmFsaWQgbW9kaWZpZXIuIFJlcGxhY2VtZW50cyBhcmUgZm9yYmlkZGVuLlwiKTtcbiAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICByZXR1cm4gY2FsbGJhY2soZXJyKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBXZSd2ZSBhbHJlYWR5IHJ1biByZXBsYWNlVHlwZXMvcmVwbGFjZU1ldGVvckF0b21XaXRoTW9uZ28gb25cbiAgICAvLyBzZWxlY3RvciBhbmQgbW9kLiAgV2UgYXNzdW1lIGl0IGRvZXNuJ3QgbWF0dGVyLCBhcyBmYXIgYXNcbiAgICAvLyB0aGUgYmVoYXZpb3Igb2YgbW9kaWZpZXJzIGlzIGNvbmNlcm5lZCwgd2hldGhlciBgX21vZGlmeWBcbiAgICAvLyBpcyBydW4gb24gRUpTT04gb3Igb24gbW9uZ28tY29udmVydGVkIEVKU09OLlxuXG4gICAgLy8gUnVuIHRoaXMgY29kZSB1cCBmcm9udCBzbyB0aGF0IGl0IGZhaWxzIGZhc3QgaWYgc29tZW9uZSB1c2VzXG4gICAgLy8gYSBNb25nbyB1cGRhdGUgb3BlcmF0b3Igd2UgZG9uJ3Qgc3VwcG9ydC5cbiAgICBsZXQga25vd25JZDtcbiAgICBpZiAob3B0aW9ucy51cHNlcnQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGxldCBuZXdEb2MgPSBMb2NhbENvbGxlY3Rpb24uX2NyZWF0ZVVwc2VydERvY3VtZW50KHNlbGVjdG9yLCBtb2QpO1xuICAgICAgICBrbm93bklkID0gbmV3RG9jLl9pZDtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICByZXR1cm4gY2FsbGJhY2soZXJyKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAob3B0aW9ucy51cHNlcnQgJiZcbiAgICAgICAgISBpc01vZGlmeSAmJlxuICAgICAgICAhIGtub3duSWQgJiZcbiAgICAgICAgb3B0aW9ucy5pbnNlcnRlZElkICYmXG4gICAgICAgICEgKG9wdGlvbnMuaW5zZXJ0ZWRJZCBpbnN0YW5jZW9mIE1vbmdvLk9iamVjdElEICYmXG4gICAgICAgICAgIG9wdGlvbnMuZ2VuZXJhdGVkSWQpKSB7XG4gICAgICAvLyBJbiBjYXNlIG9mIGFuIHVwc2VydCB3aXRoIGEgcmVwbGFjZW1lbnQsIHdoZXJlIHRoZXJlIGlzIG5vIF9pZCBkZWZpbmVkXG4gICAgICAvLyBpbiBlaXRoZXIgdGhlIHF1ZXJ5IG9yIHRoZSByZXBsYWNlbWVudCBkb2MsIG1vbmdvIHdpbGwgZ2VuZXJhdGUgYW4gaWQgaXRzZWxmLlxuICAgICAgLy8gVGhlcmVmb3JlIHdlIG5lZWQgdGhpcyBzcGVjaWFsIHN0cmF0ZWd5IGlmIHdlIHdhbnQgdG8gY29udHJvbCB0aGUgaWQgb3Vyc2VsdmVzLlxuXG4gICAgICAvLyBXZSBkb24ndCBuZWVkIHRvIGRvIHRoaXMgd2hlbjpcbiAgICAgIC8vIC0gVGhpcyBpcyBub3QgYSByZXBsYWNlbWVudCwgc28gd2UgY2FuIGFkZCBhbiBfaWQgdG8gJHNldE9uSW5zZXJ0XG4gICAgICAvLyAtIFRoZSBpZCBpcyBkZWZpbmVkIGJ5IHF1ZXJ5IG9yIG1vZCB3ZSBjYW4ganVzdCBhZGQgaXQgdG8gdGhlIHJlcGxhY2VtZW50IGRvY1xuICAgICAgLy8gLSBUaGUgdXNlciBkaWQgbm90IHNwZWNpZnkgYW55IGlkIHByZWZlcmVuY2UgYW5kIHRoZSBpZCBpcyBhIE1vbmdvIE9iamVjdElkLFxuICAgICAgLy8gICAgIHRoZW4gd2UgY2FuIGp1c3QgbGV0IE1vbmdvIGdlbmVyYXRlIHRoZSBpZFxuXG4gICAgICBzaW11bGF0ZVVwc2VydFdpdGhJbnNlcnRlZElkKFxuICAgICAgICBjb2xsZWN0aW9uLCBtb25nb1NlbGVjdG9yLCBtb25nb01vZCwgb3B0aW9ucyxcbiAgICAgICAgLy8gVGhpcyBjYWxsYmFjayBkb2VzIG5vdCBuZWVkIHRvIGJlIGJpbmRFbnZpcm9ubWVudCdlZCBiZWNhdXNlXG4gICAgICAgIC8vIHNpbXVsYXRlVXBzZXJ0V2l0aEluc2VydGVkSWQoKSB3cmFwcyBpdCBhbmQgdGhlbiBwYXNzZXMgaXQgdGhyb3VnaFxuICAgICAgICAvLyBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZS5cbiAgICAgICAgZnVuY3Rpb24gKGVycm9yLCByZXN1bHQpIHtcbiAgICAgICAgICAvLyBJZiB3ZSBnb3QgaGVyZSB2aWEgYSB1cHNlcnQoKSBjYWxsLCB0aGVuIG9wdGlvbnMuX3JldHVybk9iamVjdCB3aWxsXG4gICAgICAgICAgLy8gYmUgc2V0IGFuZCB3ZSBzaG91bGQgcmV0dXJuIHRoZSB3aG9sZSBvYmplY3QuIE90aGVyd2lzZSwgd2Ugc2hvdWxkXG4gICAgICAgICAgLy8ganVzdCByZXR1cm4gdGhlIG51bWJlciBvZiBhZmZlY3RlZCBkb2NzIHRvIG1hdGNoIHRoZSBtb25nbyBBUEkuXG4gICAgICAgICAgaWYgKHJlc3VsdCAmJiAhIG9wdGlvbnMuX3JldHVybk9iamVjdCkge1xuICAgICAgICAgICAgY2FsbGJhY2soZXJyb3IsIHJlc3VsdC5udW1iZXJBZmZlY3RlZCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGVycm9yLCByZXN1bHQpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuXG4gICAgICBpZiAob3B0aW9ucy51cHNlcnQgJiYgIWtub3duSWQgJiYgb3B0aW9ucy5pbnNlcnRlZElkICYmIGlzTW9kaWZ5KSB7XG4gICAgICAgIGlmICghbW9uZ29Nb2QuaGFzT3duUHJvcGVydHkoJyRzZXRPbkluc2VydCcpKSB7XG4gICAgICAgICAgbW9uZ29Nb2QuJHNldE9uSW5zZXJ0ID0ge307XG4gICAgICAgIH1cbiAgICAgICAga25vd25JZCA9IG9wdGlvbnMuaW5zZXJ0ZWRJZDtcbiAgICAgICAgT2JqZWN0LmFzc2lnbihtb25nb01vZC4kc2V0T25JbnNlcnQsIHJlcGxhY2VUeXBlcyh7X2lkOiBvcHRpb25zLmluc2VydGVkSWR9LCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbykpO1xuICAgICAgfVxuXG4gICAgICBjb2xsZWN0aW9uLnVwZGF0ZShcbiAgICAgICAgbW9uZ29TZWxlY3RvciwgbW9uZ29Nb2QsIG1vbmdvT3B0cyxcbiAgICAgICAgYmluZEVudmlyb25tZW50Rm9yV3JpdGUoZnVuY3Rpb24gKGVyciwgcmVzdWx0KSB7XG4gICAgICAgICAgaWYgKCEgZXJyKSB7XG4gICAgICAgICAgICB2YXIgbWV0ZW9yUmVzdWx0ID0gdHJhbnNmb3JtUmVzdWx0KHJlc3VsdCk7XG4gICAgICAgICAgICBpZiAobWV0ZW9yUmVzdWx0ICYmIG9wdGlvbnMuX3JldHVybk9iamVjdCkge1xuICAgICAgICAgICAgICAvLyBJZiB0aGlzIHdhcyBhbiB1cHNlcnQoKSBjYWxsLCBhbmQgd2UgZW5kZWQgdXBcbiAgICAgICAgICAgICAgLy8gaW5zZXJ0aW5nIGEgbmV3IGRvYyBhbmQgd2Uga25vdyBpdHMgaWQsIHRoZW5cbiAgICAgICAgICAgICAgLy8gcmV0dXJuIHRoYXQgaWQgYXMgd2VsbC5cbiAgICAgICAgICAgICAgaWYgKG9wdGlvbnMudXBzZXJ0ICYmIG1ldGVvclJlc3VsdC5pbnNlcnRlZElkKSB7XG4gICAgICAgICAgICAgICAgaWYgKGtub3duSWQpIHtcbiAgICAgICAgICAgICAgICAgIG1ldGVvclJlc3VsdC5pbnNlcnRlZElkID0ga25vd25JZDtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG1ldGVvclJlc3VsdC5pbnNlcnRlZElkIGluc3RhbmNlb2YgTW9uZ29EQi5PYmplY3RJRCkge1xuICAgICAgICAgICAgICAgICAgbWV0ZW9yUmVzdWx0Lmluc2VydGVkSWQgPSBuZXcgTW9uZ28uT2JqZWN0SUQobWV0ZW9yUmVzdWx0Lmluc2VydGVkSWQudG9IZXhTdHJpbmcoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgY2FsbGJhY2soZXJyLCBtZXRlb3JSZXN1bHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgY2FsbGJhY2soZXJyLCBtZXRlb3JSZXN1bHQubnVtYmVyQWZmZWN0ZWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIHdyaXRlLmNvbW1pdHRlZCgpO1xuICAgIHRocm93IGU7XG4gIH1cbn07XG5cbnZhciB0cmFuc2Zvcm1SZXN1bHQgPSBmdW5jdGlvbiAoZHJpdmVyUmVzdWx0KSB7XG4gIHZhciBtZXRlb3JSZXN1bHQgPSB7IG51bWJlckFmZmVjdGVkOiAwIH07XG4gIGlmIChkcml2ZXJSZXN1bHQpIHtcbiAgICB2YXIgbW9uZ29SZXN1bHQgPSBkcml2ZXJSZXN1bHQucmVzdWx0O1xuXG4gICAgLy8gT24gdXBkYXRlcyB3aXRoIHVwc2VydDp0cnVlLCB0aGUgaW5zZXJ0ZWQgdmFsdWVzIGNvbWUgYXMgYSBsaXN0IG9mXG4gICAgLy8gdXBzZXJ0ZWQgdmFsdWVzIC0tIGV2ZW4gd2l0aCBvcHRpb25zLm11bHRpLCB3aGVuIHRoZSB1cHNlcnQgZG9lcyBpbnNlcnQsXG4gICAgLy8gaXQgb25seSBpbnNlcnRzIG9uZSBlbGVtZW50LlxuICAgIGlmIChtb25nb1Jlc3VsdC51cHNlcnRlZCkge1xuICAgICAgbWV0ZW9yUmVzdWx0Lm51bWJlckFmZmVjdGVkICs9IG1vbmdvUmVzdWx0LnVwc2VydGVkLmxlbmd0aDtcblxuICAgICAgaWYgKG1vbmdvUmVzdWx0LnVwc2VydGVkLmxlbmd0aCA9PSAxKSB7XG4gICAgICAgIG1ldGVvclJlc3VsdC5pbnNlcnRlZElkID0gbW9uZ29SZXN1bHQudXBzZXJ0ZWRbMF0uX2lkO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBtZXRlb3JSZXN1bHQubnVtYmVyQWZmZWN0ZWQgPSBtb25nb1Jlc3VsdC5uO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBtZXRlb3JSZXN1bHQ7XG59O1xuXG5cbnZhciBOVU1fT1BUSU1JU1RJQ19UUklFUyA9IDM7XG5cbi8vIGV4cG9zZWQgZm9yIHRlc3Rpbmdcbk1vbmdvQ29ubmVjdGlvbi5faXNDYW5ub3RDaGFuZ2VJZEVycm9yID0gZnVuY3Rpb24gKGVycikge1xuXG4gIC8vIE1vbmdvIDMuMi4qIHJldHVybnMgZXJyb3IgYXMgbmV4dCBPYmplY3Q6XG4gIC8vIHtuYW1lOiBTdHJpbmcsIGNvZGU6IE51bWJlciwgZXJybXNnOiBTdHJpbmd9XG4gIC8vIE9sZGVyIE1vbmdvIHJldHVybnM6XG4gIC8vIHtuYW1lOiBTdHJpbmcsIGNvZGU6IE51bWJlciwgZXJyOiBTdHJpbmd9XG4gIHZhciBlcnJvciA9IGVyci5lcnJtc2cgfHwgZXJyLmVycjtcblxuICAvLyBXZSBkb24ndCB1c2UgdGhlIGVycm9yIGNvZGUgaGVyZVxuICAvLyBiZWNhdXNlIHRoZSBlcnJvciBjb2RlIHdlIG9ic2VydmVkIGl0IHByb2R1Y2luZyAoMTY4MzcpIGFwcGVhcnMgdG8gYmVcbiAgLy8gYSBmYXIgbW9yZSBnZW5lcmljIGVycm9yIGNvZGUgYmFzZWQgb24gZXhhbWluaW5nIHRoZSBzb3VyY2UuXG4gIGlmIChlcnJvci5pbmRleE9mKCdUaGUgX2lkIGZpZWxkIGNhbm5vdCBiZSBjaGFuZ2VkJykgPT09IDBcbiAgICB8fCBlcnJvci5pbmRleE9mKFwidGhlIChpbW11dGFibGUpIGZpZWxkICdfaWQnIHdhcyBmb3VuZCB0byBoYXZlIGJlZW4gYWx0ZXJlZCB0byBfaWRcIikgIT09IC0xKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59O1xuXG52YXIgc2ltdWxhdGVVcHNlcnRXaXRoSW5zZXJ0ZWRJZCA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uLCBzZWxlY3RvciwgbW9kLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgLy8gU1RSQVRFR1k6IEZpcnN0IHRyeSBkb2luZyBhbiB1cHNlcnQgd2l0aCBhIGdlbmVyYXRlZCBJRC5cbiAgLy8gSWYgdGhpcyB0aHJvd3MgYW4gZXJyb3IgYWJvdXQgY2hhbmdpbmcgdGhlIElEIG9uIGFuIGV4aXN0aW5nIGRvY3VtZW50XG4gIC8vIHRoZW4gd2l0aG91dCBhZmZlY3RpbmcgdGhlIGRhdGFiYXNlLCB3ZSBrbm93IHdlIHNob3VsZCBwcm9iYWJseSB0cnlcbiAgLy8gYW4gdXBkYXRlIHdpdGhvdXQgdGhlIGdlbmVyYXRlZCBJRC4gSWYgaXQgYWZmZWN0ZWQgMCBkb2N1bWVudHMsXG4gIC8vIHRoZW4gd2l0aG91dCBhZmZlY3RpbmcgdGhlIGRhdGFiYXNlLCB3ZSB0aGUgZG9jdW1lbnQgdGhhdCBmaXJzdFxuICAvLyBnYXZlIHRoZSBlcnJvciBpcyBwcm9iYWJseSByZW1vdmVkIGFuZCB3ZSBuZWVkIHRvIHRyeSBhbiBpbnNlcnQgYWdhaW5cbiAgLy8gV2UgZ28gYmFjayB0byBzdGVwIG9uZSBhbmQgcmVwZWF0LlxuICAvLyBMaWtlIGFsbCBcIm9wdGltaXN0aWMgd3JpdGVcIiBzY2hlbWVzLCB3ZSByZWx5IG9uIHRoZSBmYWN0IHRoYXQgaXQnc1xuICAvLyB1bmxpa2VseSBvdXIgd3JpdGVzIHdpbGwgY29udGludWUgdG8gYmUgaW50ZXJmZXJlZCB3aXRoIHVuZGVyIG5vcm1hbFxuICAvLyBjaXJjdW1zdGFuY2VzICh0aG91Z2ggc3VmZmljaWVudGx5IGhlYXZ5IGNvbnRlbnRpb24gd2l0aCB3cml0ZXJzXG4gIC8vIGRpc2FncmVlaW5nIG9uIHRoZSBleGlzdGVuY2Ugb2YgYW4gb2JqZWN0IHdpbGwgY2F1c2Ugd3JpdGVzIHRvIGZhaWxcbiAgLy8gaW4gdGhlb3J5KS5cblxuICB2YXIgaW5zZXJ0ZWRJZCA9IG9wdGlvbnMuaW5zZXJ0ZWRJZDsgLy8gbXVzdCBleGlzdFxuICB2YXIgbW9uZ29PcHRzRm9yVXBkYXRlID0ge1xuICAgIHNhZmU6IHRydWUsXG4gICAgbXVsdGk6IG9wdGlvbnMubXVsdGlcbiAgfTtcbiAgdmFyIG1vbmdvT3B0c0Zvckluc2VydCA9IHtcbiAgICBzYWZlOiB0cnVlLFxuICAgIHVwc2VydDogdHJ1ZVxuICB9O1xuXG4gIHZhciByZXBsYWNlbWVudFdpdGhJZCA9IE9iamVjdC5hc3NpZ24oXG4gICAgcmVwbGFjZVR5cGVzKHtfaWQ6IGluc2VydGVkSWR9LCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyksXG4gICAgbW9kKTtcblxuICB2YXIgdHJpZXMgPSBOVU1fT1BUSU1JU1RJQ19UUklFUztcblxuICB2YXIgZG9VcGRhdGUgPSBmdW5jdGlvbiAoKSB7XG4gICAgdHJpZXMtLTtcbiAgICBpZiAoISB0cmllcykge1xuICAgICAgY2FsbGJhY2sobmV3IEVycm9yKFwiVXBzZXJ0IGZhaWxlZCBhZnRlciBcIiArIE5VTV9PUFRJTUlTVElDX1RSSUVTICsgXCIgdHJpZXMuXCIpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29sbGVjdGlvbi51cGRhdGUoc2VsZWN0b3IsIG1vZCwgbW9uZ29PcHRzRm9yVXBkYXRlLFxuICAgICAgICAgICAgICAgICAgICAgICAgYmluZEVudmlyb25tZW50Rm9yV3JpdGUoZnVuY3Rpb24gKGVyciwgcmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHJlc3VsdCAmJiByZXN1bHQucmVzdWx0Lm4gIT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG51bWJlckFmZmVjdGVkOiByZXN1bHQucmVzdWx0Lm5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkb0NvbmRpdGlvbmFsSW5zZXJ0KCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICB9XG4gIH07XG5cbiAgdmFyIGRvQ29uZGl0aW9uYWxJbnNlcnQgPSBmdW5jdGlvbiAoKSB7XG4gICAgY29sbGVjdGlvbi51cGRhdGUoc2VsZWN0b3IsIHJlcGxhY2VtZW50V2l0aElkLCBtb25nb09wdHNGb3JJbnNlcnQsXG4gICAgICAgICAgICAgICAgICAgICAgYmluZEVudmlyb25tZW50Rm9yV3JpdGUoZnVuY3Rpb24gKGVyciwgcmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGZpZ3VyZSBvdXQgaWYgdGhpcyBpcyBhXG4gICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFwiY2Fubm90IGNoYW5nZSBfaWQgb2YgZG9jdW1lbnRcIiBlcnJvciwgYW5kXG4gICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGlmIHNvLCB0cnkgZG9VcGRhdGUoKSBhZ2FpbiwgdXAgdG8gMyB0aW1lcy5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKE1vbmdvQ29ubmVjdGlvbi5faXNDYW5ub3RDaGFuZ2VJZEVycm9yKGVycikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkb1VwZGF0ZSgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBudW1iZXJBZmZlY3RlZDogcmVzdWx0LnJlc3VsdC51cHNlcnRlZC5sZW5ndGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaW5zZXJ0ZWRJZDogaW5zZXJ0ZWRJZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgfSkpO1xuICB9O1xuXG4gIGRvVXBkYXRlKCk7XG59O1xuXG5fLmVhY2goW1wiaW5zZXJ0XCIsIFwidXBkYXRlXCIsIFwicmVtb3ZlXCIsIFwiZHJvcENvbGxlY3Rpb25cIiwgXCJkcm9wRGF0YWJhc2VcIl0sIGZ1bmN0aW9uIChtZXRob2QpIHtcbiAgTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZVttZXRob2RdID0gZnVuY3Rpb24gKC8qIGFyZ3VtZW50cyAqLykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICByZXR1cm4gTWV0ZW9yLndyYXBBc3luYyhzZWxmW1wiX1wiICsgbWV0aG9kXSkuYXBwbHkoc2VsZiwgYXJndW1lbnRzKTtcbiAgfTtcbn0pO1xuXG4vLyBYWFggTW9uZ29Db25uZWN0aW9uLnVwc2VydCgpIGRvZXMgbm90IHJldHVybiB0aGUgaWQgb2YgdGhlIGluc2VydGVkIGRvY3VtZW50XG4vLyB1bmxlc3MgeW91IHNldCBpdCBleHBsaWNpdGx5IGluIHRoZSBzZWxlY3RvciBvciBtb2RpZmllciAoYXMgYSByZXBsYWNlbWVudFxuLy8gZG9jKS5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUudXBzZXJ0ID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBzZWxlY3RvciwgbW9kLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBpZiAodHlwZW9mIG9wdGlvbnMgPT09IFwiZnVuY3Rpb25cIiAmJiAhIGNhbGxiYWNrKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuXG4gIHJldHVybiBzZWxmLnVwZGF0ZShjb2xsZWN0aW9uTmFtZSwgc2VsZWN0b3IsIG1vZCxcbiAgICAgICAgICAgICAgICAgICAgIF8uZXh0ZW5kKHt9LCBvcHRpb25zLCB7XG4gICAgICAgICAgICAgICAgICAgICAgIHVwc2VydDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgX3JldHVybk9iamVjdDogdHJ1ZVxuICAgICAgICAgICAgICAgICAgICAgfSksIGNhbGxiYWNrKTtcbn07XG5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuZmluZCA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSwgc2VsZWN0b3IsIG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAxKVxuICAgIHNlbGVjdG9yID0ge307XG5cbiAgcmV0dXJuIG5ldyBDdXJzb3IoXG4gICAgc2VsZiwgbmV3IEN1cnNvckRlc2NyaXB0aW9uKGNvbGxlY3Rpb25OYW1lLCBzZWxlY3Rvciwgb3B0aW9ucykpO1xufTtcblxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5maW5kT25lID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25fbmFtZSwgc2VsZWN0b3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9ucykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAxKVxuICAgIHNlbGVjdG9yID0ge307XG5cbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gIG9wdGlvbnMubGltaXQgPSAxO1xuICByZXR1cm4gc2VsZi5maW5kKGNvbGxlY3Rpb25fbmFtZSwgc2VsZWN0b3IsIG9wdGlvbnMpLmZldGNoKClbMF07XG59O1xuXG4vLyBXZSdsbCBhY3R1YWxseSBkZXNpZ24gYW4gaW5kZXggQVBJIGxhdGVyLiBGb3Igbm93LCB3ZSBqdXN0IHBhc3MgdGhyb3VnaCB0b1xuLy8gTW9uZ28ncywgYnV0IG1ha2UgaXQgc3luY2hyb25vdXMuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9lbnN1cmVJbmRleCA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSwgaW5kZXgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zKSB7XG4gIHRyeSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIC8vIFdlIGV4cGVjdCB0aGlzIGZ1bmN0aW9uIHRvIGJlIGNhbGxlZCBhdCBzdGFydHVwLCBub3QgZnJvbSB3aXRoaW4gYSBtZXRob2QsXG4gICAgLy8gc28gd2UgZG9uJ3QgaW50ZXJhY3Qgd2l0aCB0aGUgd3JpdGUgZmVuY2UuXG4gICAgdmFyIGNvbGxlY3Rpb24gPSBzZWxmLnJhd0NvbGxlY3Rpb24oY29sbGVjdGlvbk5hbWUpO1xuICAgIHZhciBmdXR1cmUgPSBuZXcgRnV0dXJlO1xuICAgIHZhciBpbmRleE5hbWUgPSBjb2xsZWN0aW9uLmVuc3VyZUluZGV4KGluZGV4LCBvcHRpb25zLCBmdXR1cmUucmVzb2x2ZXIoKSk7XG4gICAgZnV0dXJlLndhaXQoKTtcbiAgfSBjYXRjaCAoRXhjZXB0aW9uKSB7XG4gICAgXG4gIH1cbn07XG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9kcm9wSW5kZXggPSBmdW5jdGlvbiAoY29sbGVjdGlvbk5hbWUsIGluZGV4KSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICAvLyBUaGlzIGZ1bmN0aW9uIGlzIG9ubHkgdXNlZCBieSB0ZXN0IGNvZGUsIG5vdCB3aXRoaW4gYSBtZXRob2QsIHNvIHdlIGRvbid0XG4gIC8vIGludGVyYWN0IHdpdGggdGhlIHdyaXRlIGZlbmNlLlxuICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjb2xsZWN0aW9uTmFtZSk7XG4gIHZhciBmdXR1cmUgPSBuZXcgRnV0dXJlO1xuICB2YXIgaW5kZXhOYW1lID0gY29sbGVjdGlvbi5kcm9wSW5kZXgoaW5kZXgsIGZ1dHVyZS5yZXNvbHZlcigpKTtcbiAgZnV0dXJlLndhaXQoKTtcbn07XG5cbi8vIENVUlNPUlNcblxuLy8gVGhlcmUgYXJlIHNldmVyYWwgY2xhc3NlcyB3aGljaCByZWxhdGUgdG8gY3Vyc29yczpcbi8vXG4vLyBDdXJzb3JEZXNjcmlwdGlvbiByZXByZXNlbnRzIHRoZSBhcmd1bWVudHMgdXNlZCB0byBjb25zdHJ1Y3QgYSBjdXJzb3I6XG4vLyBjb2xsZWN0aW9uTmFtZSwgc2VsZWN0b3IsIGFuZCAoZmluZCkgb3B0aW9ucy4gIEJlY2F1c2UgaXQgaXMgdXNlZCBhcyBhIGtleVxuLy8gZm9yIGN1cnNvciBkZS1kdXAsIGV2ZXJ5dGhpbmcgaW4gaXQgc2hvdWxkIGVpdGhlciBiZSBKU09OLXN0cmluZ2lmaWFibGUgb3Jcbi8vIG5vdCBhZmZlY3Qgb2JzZXJ2ZUNoYW5nZXMgb3V0cHV0IChlZywgb3B0aW9ucy50cmFuc2Zvcm0gZnVuY3Rpb25zIGFyZSBub3Rcbi8vIHN0cmluZ2lmaWFibGUgYnV0IGRvIG5vdCBhZmZlY3Qgb2JzZXJ2ZUNoYW5nZXMpLlxuLy9cbi8vIFN5bmNocm9ub3VzQ3Vyc29yIGlzIGEgd3JhcHBlciBhcm91bmQgYSBNb25nb0RCIGN1cnNvclxuLy8gd2hpY2ggaW5jbHVkZXMgZnVsbHktc3luY2hyb25vdXMgdmVyc2lvbnMgb2YgZm9yRWFjaCwgZXRjLlxuLy9cbi8vIEN1cnNvciBpcyB0aGUgY3Vyc29yIG9iamVjdCByZXR1cm5lZCBmcm9tIGZpbmQoKSwgd2hpY2ggaW1wbGVtZW50cyB0aGVcbi8vIGRvY3VtZW50ZWQgTW9uZ28uQ29sbGVjdGlvbiBjdXJzb3IgQVBJLiAgSXQgd3JhcHMgYSBDdXJzb3JEZXNjcmlwdGlvbiBhbmQgYVxuLy8gU3luY2hyb25vdXNDdXJzb3IgKGxhemlseTogaXQgZG9lc24ndCBjb250YWN0IE1vbmdvIHVudGlsIHlvdSBjYWxsIGEgbWV0aG9kXG4vLyBsaWtlIGZldGNoIG9yIGZvckVhY2ggb24gaXQpLlxuLy9cbi8vIE9ic2VydmVIYW5kbGUgaXMgdGhlIFwib2JzZXJ2ZSBoYW5kbGVcIiByZXR1cm5lZCBmcm9tIG9ic2VydmVDaGFuZ2VzLiBJdCBoYXMgYVxuLy8gcmVmZXJlbmNlIHRvIGFuIE9ic2VydmVNdWx0aXBsZXhlci5cbi8vXG4vLyBPYnNlcnZlTXVsdGlwbGV4ZXIgYWxsb3dzIG11bHRpcGxlIGlkZW50aWNhbCBPYnNlcnZlSGFuZGxlcyB0byBiZSBkcml2ZW4gYnkgYVxuLy8gc2luZ2xlIG9ic2VydmUgZHJpdmVyLlxuLy9cbi8vIFRoZXJlIGFyZSB0d28gXCJvYnNlcnZlIGRyaXZlcnNcIiB3aGljaCBkcml2ZSBPYnNlcnZlTXVsdGlwbGV4ZXJzOlxuLy8gICAtIFBvbGxpbmdPYnNlcnZlRHJpdmVyIGNhY2hlcyB0aGUgcmVzdWx0cyBvZiBhIHF1ZXJ5IGFuZCByZXJ1bnMgaXQgd2hlblxuLy8gICAgIG5lY2Vzc2FyeS5cbi8vICAgLSBPcGxvZ09ic2VydmVEcml2ZXIgZm9sbG93cyB0aGUgTW9uZ28gb3BlcmF0aW9uIGxvZyB0byBkaXJlY3RseSBvYnNlcnZlXG4vLyAgICAgZGF0YWJhc2UgY2hhbmdlcy5cbi8vIEJvdGggaW1wbGVtZW50YXRpb25zIGZvbGxvdyB0aGUgc2FtZSBzaW1wbGUgaW50ZXJmYWNlOiB3aGVuIHlvdSBjcmVhdGUgdGhlbSxcbi8vIHRoZXkgc3RhcnQgc2VuZGluZyBvYnNlcnZlQ2hhbmdlcyBjYWxsYmFja3MgKGFuZCBhIHJlYWR5KCkgaW52b2NhdGlvbikgdG9cbi8vIHRoZWlyIE9ic2VydmVNdWx0aXBsZXhlciwgYW5kIHlvdSBzdG9wIHRoZW0gYnkgY2FsbGluZyB0aGVpciBzdG9wKCkgbWV0aG9kLlxuXG5DdXJzb3JEZXNjcmlwdGlvbiA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSwgc2VsZWN0b3IsIG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBzZWxmLmNvbGxlY3Rpb25OYW1lID0gY29sbGVjdGlvbk5hbWU7XG4gIHNlbGYuc2VsZWN0b3IgPSBNb25nby5Db2xsZWN0aW9uLl9yZXdyaXRlU2VsZWN0b3Ioc2VsZWN0b3IpO1xuICBzZWxmLm9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xufTtcblxuQ3Vyc29yID0gZnVuY3Rpb24gKG1vbmdvLCBjdXJzb3JEZXNjcmlwdGlvbikge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgc2VsZi5fbW9uZ28gPSBtb25nbztcbiAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24gPSBjdXJzb3JEZXNjcmlwdGlvbjtcbiAgc2VsZi5fc3luY2hyb25vdXNDdXJzb3IgPSBudWxsO1xufTtcblxuXy5lYWNoKFsnZm9yRWFjaCcsICdtYXAnLCAnZmV0Y2gnLCAnY291bnQnLCBTeW1ib2wuaXRlcmF0b3JdLCBmdW5jdGlvbiAobWV0aG9kKSB7XG4gIEN1cnNvci5wcm90b3R5cGVbbWV0aG9kXSA9IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICAvLyBZb3UgY2FuIG9ubHkgb2JzZXJ2ZSBhIHRhaWxhYmxlIGN1cnNvci5cbiAgICBpZiAoc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50YWlsYWJsZSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbm5vdCBjYWxsIFwiICsgbWV0aG9kICsgXCIgb24gYSB0YWlsYWJsZSBjdXJzb3JcIik7XG5cbiAgICBpZiAoIXNlbGYuX3N5bmNocm9ub3VzQ3Vyc29yKSB7XG4gICAgICBzZWxmLl9zeW5jaHJvbm91c0N1cnNvciA9IHNlbGYuX21vbmdvLl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvcihcbiAgICAgICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24sIHtcbiAgICAgICAgICAvLyBNYWtlIHN1cmUgdGhhdCB0aGUgXCJzZWxmXCIgYXJndW1lbnQgdG8gZm9yRWFjaC9tYXAgY2FsbGJhY2tzIGlzIHRoZVxuICAgICAgICAgIC8vIEN1cnNvciwgbm90IHRoZSBTeW5jaHJvbm91c0N1cnNvci5cbiAgICAgICAgICBzZWxmRm9ySXRlcmF0aW9uOiBzZWxmLFxuICAgICAgICAgIHVzZVRyYW5zZm9ybTogdHJ1ZVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gc2VsZi5fc3luY2hyb25vdXNDdXJzb3JbbWV0aG9kXS5hcHBseShcbiAgICAgIHNlbGYuX3N5bmNocm9ub3VzQ3Vyc29yLCBhcmd1bWVudHMpO1xuICB9O1xufSk7XG5cbi8vIFNpbmNlIHdlIGRvbid0IGFjdHVhbGx5IGhhdmUgYSBcIm5leHRPYmplY3RcIiBpbnRlcmZhY2UsIHRoZXJlJ3MgcmVhbGx5IG5vXG4vLyByZWFzb24gdG8gaGF2ZSBhIFwicmV3aW5kXCIgaW50ZXJmYWNlLiAgQWxsIGl0IGRpZCB3YXMgbWFrZSBtdWx0aXBsZSBjYWxsc1xuLy8gdG8gZmV0Y2gvbWFwL2ZvckVhY2ggcmV0dXJuIG5vdGhpbmcgdGhlIHNlY29uZCB0aW1lLlxuLy8gWFhYIENPTVBBVCBXSVRIIDAuOC4xXG5DdXJzb3IucHJvdG90eXBlLnJld2luZCA9IGZ1bmN0aW9uICgpIHtcbn07XG5cbkN1cnNvci5wcm90b3R5cGUuZ2V0VHJhbnNmb3JtID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50cmFuc2Zvcm07XG59O1xuXG4vLyBXaGVuIHlvdSBjYWxsIE1ldGVvci5wdWJsaXNoKCkgd2l0aCBhIGZ1bmN0aW9uIHRoYXQgcmV0dXJucyBhIEN1cnNvciwgd2UgbmVlZFxuLy8gdG8gdHJhbnNtdXRlIGl0IGludG8gdGhlIGVxdWl2YWxlbnQgc3Vic2NyaXB0aW9uLiAgVGhpcyBpcyB0aGUgZnVuY3Rpb24gdGhhdFxuLy8gZG9lcyB0aGF0LlxuXG5DdXJzb3IucHJvdG90eXBlLl9wdWJsaXNoQ3Vyc29yID0gZnVuY3Rpb24gKHN1Yikge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHZhciBjb2xsZWN0aW9uID0gc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWU7XG4gIHJldHVybiBNb25nby5Db2xsZWN0aW9uLl9wdWJsaXNoQ3Vyc29yKHNlbGYsIHN1YiwgY29sbGVjdGlvbik7XG59O1xuXG4vLyBVc2VkIHRvIGd1YXJhbnRlZSB0aGF0IHB1Ymxpc2ggZnVuY3Rpb25zIHJldHVybiBhdCBtb3N0IG9uZSBjdXJzb3IgcGVyXG4vLyBjb2xsZWN0aW9uLiBQcml2YXRlLCBiZWNhdXNlIHdlIG1pZ2h0IGxhdGVyIGhhdmUgY3Vyc29ycyB0aGF0IGluY2x1ZGVcbi8vIGRvY3VtZW50cyBmcm9tIG11bHRpcGxlIGNvbGxlY3Rpb25zIHNvbWVob3cuXG5DdXJzb3IucHJvdG90eXBlLl9nZXRDb2xsZWN0aW9uTmFtZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICByZXR1cm4gc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWU7XG59O1xuXG5DdXJzb3IucHJvdG90eXBlLm9ic2VydmUgPSBmdW5jdGlvbiAoY2FsbGJhY2tzKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgcmV0dXJuIExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUZyb21PYnNlcnZlQ2hhbmdlcyhzZWxmLCBjYWxsYmFja3MpO1xufTtcblxuQ3Vyc29yLnByb3RvdHlwZS5vYnNlcnZlQ2hhbmdlcyA9IGZ1bmN0aW9uIChjYWxsYmFja3MpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICB2YXIgbWV0aG9kcyA9IFtcbiAgICAnYWRkZWRBdCcsXG4gICAgJ2FkZGVkJyxcbiAgICAnY2hhbmdlZEF0JyxcbiAgICAnY2hhbmdlZCcsXG4gICAgJ3JlbW92ZWRBdCcsXG4gICAgJ3JlbW92ZWQnLFxuICAgICdtb3ZlZFRvJ1xuICBdO1xuICB2YXIgb3JkZXJlZCA9IExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3NBcmVPcmRlcmVkKGNhbGxiYWNrcyk7XG5cbiAgLy8gWFhYOiBDYW4gd2UgZmluZCBvdXQgaWYgY2FsbGJhY2tzIGFyZSBmcm9tIG9ic2VydmU/XG4gIHZhciBleGNlcHRpb25OYW1lID0gJyBvYnNlcnZlL29ic2VydmVDaGFuZ2VzIGNhbGxiYWNrJztcbiAgbWV0aG9kcy5mb3JFYWNoKGZ1bmN0aW9uIChtZXRob2QpIHtcbiAgICBpZiAoY2FsbGJhY2tzW21ldGhvZF0gJiYgdHlwZW9mIGNhbGxiYWNrc1ttZXRob2RdID09IFwiZnVuY3Rpb25cIikge1xuICAgICAgY2FsbGJhY2tzW21ldGhvZF0gPSBNZXRlb3IuYmluZEVudmlyb25tZW50KGNhbGxiYWNrc1ttZXRob2RdLCBtZXRob2QgKyBleGNlcHRpb25OYW1lKTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiBzZWxmLl9tb25nby5fb2JzZXJ2ZUNoYW5nZXMoXG4gICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24sIG9yZGVyZWQsIGNhbGxiYWNrcyk7XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvciA9IGZ1bmN0aW9uKFxuICAgIGN1cnNvckRlc2NyaXB0aW9uLCBvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgb3B0aW9ucyA9IF8ucGljayhvcHRpb25zIHx8IHt9LCAnc2VsZkZvckl0ZXJhdGlvbicsICd1c2VUcmFuc2Zvcm0nKTtcblxuICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjdXJzb3JEZXNjcmlwdGlvbi5jb2xsZWN0aW9uTmFtZSk7XG4gIHZhciBjdXJzb3JPcHRpb25zID0gY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucztcbiAgdmFyIG1vbmdvT3B0aW9ucyA9IHtcbiAgICBzb3J0OiBjdXJzb3JPcHRpb25zLnNvcnQsXG4gICAgbGltaXQ6IGN1cnNvck9wdGlvbnMubGltaXQsXG4gICAgc2tpcDogY3Vyc29yT3B0aW9ucy5za2lwLFxuICAgIHByb2plY3Rpb246IGN1cnNvck9wdGlvbnMuZmllbGRzXG4gIH07XG5cbiAgLy8gRG8gd2Ugd2FudCBhIHRhaWxhYmxlIGN1cnNvciAod2hpY2ggb25seSB3b3JrcyBvbiBjYXBwZWQgY29sbGVjdGlvbnMpP1xuICBpZiAoY3Vyc29yT3B0aW9ucy50YWlsYWJsZSkge1xuICAgIC8vIFdlIHdhbnQgYSB0YWlsYWJsZSBjdXJzb3IuLi5cbiAgICBtb25nb09wdGlvbnMudGFpbGFibGUgPSB0cnVlO1xuICAgIC8vIC4uLiBhbmQgZm9yIHRoZSBzZXJ2ZXIgdG8gd2FpdCBhIGJpdCBpZiBhbnkgZ2V0TW9yZSBoYXMgbm8gZGF0YSAocmF0aGVyXG4gICAgLy8gdGhhbiBtYWtpbmcgdXMgcHV0IHRoZSByZWxldmFudCBzbGVlcHMgaW4gdGhlIGNsaWVudCkuLi5cbiAgICBtb25nb09wdGlvbnMuYXdhaXRkYXRhID0gdHJ1ZTtcbiAgICAvLyAuLi4gYW5kIHRvIGtlZXAgcXVlcnlpbmcgdGhlIHNlcnZlciBpbmRlZmluaXRlbHkgcmF0aGVyIHRoYW4ganVzdCA1IHRpbWVzXG4gICAgLy8gaWYgdGhlcmUncyBubyBtb3JlIGRhdGEuXG4gICAgbW9uZ29PcHRpb25zLm51bWJlck9mUmV0cmllcyA9IC0xO1xuICAgIC8vIEFuZCBpZiB0aGlzIGlzIG9uIHRoZSBvcGxvZyBjb2xsZWN0aW9uIGFuZCB0aGUgY3Vyc29yIHNwZWNpZmllcyBhICd0cycsXG4gICAgLy8gdGhlbiBzZXQgdGhlIHVuZG9jdW1lbnRlZCBvcGxvZyByZXBsYXkgZmxhZywgd2hpY2ggZG9lcyBhIHNwZWNpYWwgc2NhbiB0b1xuICAgIC8vIGZpbmQgdGhlIGZpcnN0IGRvY3VtZW50IChpbnN0ZWFkIG9mIGNyZWF0aW5nIGFuIGluZGV4IG9uIHRzKS4gVGhpcyBpcyBhXG4gICAgLy8gdmVyeSBoYXJkLWNvZGVkIE1vbmdvIGZsYWcgd2hpY2ggb25seSB3b3JrcyBvbiB0aGUgb3Bsb2cgY29sbGVjdGlvbiBhbmRcbiAgICAvLyBvbmx5IHdvcmtzIHdpdGggdGhlIHRzIGZpZWxkLlxuICAgIGlmIChjdXJzb3JEZXNjcmlwdGlvbi5jb2xsZWN0aW9uTmFtZSA9PT0gT1BMT0dfQ09MTEVDVElPTiAmJlxuICAgICAgICBjdXJzb3JEZXNjcmlwdGlvbi5zZWxlY3Rvci50cykge1xuICAgICAgbW9uZ29PcHRpb25zLm9wbG9nUmVwbGF5ID0gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICB2YXIgZGJDdXJzb3IgPSBjb2xsZWN0aW9uLmZpbmQoXG4gICAgcmVwbGFjZVR5cGVzKGN1cnNvckRlc2NyaXB0aW9uLnNlbGVjdG9yLCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyksXG4gICAgbW9uZ29PcHRpb25zKTtcblxuICBpZiAodHlwZW9mIGN1cnNvck9wdGlvbnMubWF4VGltZU1zICE9PSAndW5kZWZpbmVkJykge1xuICAgIGRiQ3Vyc29yID0gZGJDdXJzb3IubWF4VGltZU1TKGN1cnNvck9wdGlvbnMubWF4VGltZU1zKTtcbiAgfVxuICBpZiAodHlwZW9mIGN1cnNvck9wdGlvbnMuaGludCAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICBkYkN1cnNvciA9IGRiQ3Vyc29yLmhpbnQoY3Vyc29yT3B0aW9ucy5oaW50KTtcbiAgfVxuXG4gIHJldHVybiBuZXcgU3luY2hyb25vdXNDdXJzb3IoZGJDdXJzb3IsIGN1cnNvckRlc2NyaXB0aW9uLCBvcHRpb25zKTtcbn07XG5cbnZhciBTeW5jaHJvbm91c0N1cnNvciA9IGZ1bmN0aW9uIChkYkN1cnNvciwgY3Vyc29yRGVzY3JpcHRpb24sIG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBvcHRpb25zID0gXy5waWNrKG9wdGlvbnMgfHwge30sICdzZWxmRm9ySXRlcmF0aW9uJywgJ3VzZVRyYW5zZm9ybScpO1xuXG4gIHNlbGYuX2RiQ3Vyc29yID0gZGJDdXJzb3I7XG4gIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uID0gY3Vyc29yRGVzY3JpcHRpb247XG4gIC8vIFRoZSBcInNlbGZcIiBhcmd1bWVudCBwYXNzZWQgdG8gZm9yRWFjaC9tYXAgY2FsbGJhY2tzLiBJZiB3ZSdyZSB3cmFwcGVkXG4gIC8vIGluc2lkZSBhIHVzZXItdmlzaWJsZSBDdXJzb3IsIHdlIHdhbnQgdG8gcHJvdmlkZSB0aGUgb3V0ZXIgY3Vyc29yIVxuICBzZWxmLl9zZWxmRm9ySXRlcmF0aW9uID0gb3B0aW9ucy5zZWxmRm9ySXRlcmF0aW9uIHx8IHNlbGY7XG4gIGlmIChvcHRpb25zLnVzZVRyYW5zZm9ybSAmJiBjdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLnRyYW5zZm9ybSkge1xuICAgIHNlbGYuX3RyYW5zZm9ybSA9IExvY2FsQ29sbGVjdGlvbi53cmFwVHJhbnNmb3JtKFxuICAgICAgY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50cmFuc2Zvcm0pO1xuICB9IGVsc2Uge1xuICAgIHNlbGYuX3RyYW5zZm9ybSA9IG51bGw7XG4gIH1cblxuICBzZWxmLl9zeW5jaHJvbm91c0NvdW50ID0gRnV0dXJlLndyYXAoZGJDdXJzb3IuY291bnQuYmluZChkYkN1cnNvcikpO1xuICBzZWxmLl92aXNpdGVkSWRzID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG59O1xuXG5fLmV4dGVuZChTeW5jaHJvbm91c0N1cnNvci5wcm90b3R5cGUsIHtcbiAgLy8gUmV0dXJucyBhIFByb21pc2UgZm9yIHRoZSBuZXh0IG9iamVjdCBmcm9tIHRoZSB1bmRlcmx5aW5nIGN1cnNvciAoYmVmb3JlXG4gIC8vIHRoZSBNb25nby0+TWV0ZW9yIHR5cGUgcmVwbGFjZW1lbnQpLlxuICBfcmF3TmV4dE9iamVjdFByb21pc2U6IGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgc2VsZi5fZGJDdXJzb3IubmV4dCgoZXJyLCBkb2MpID0+IHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc29sdmUoZG9jKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gUmV0dXJucyBhIFByb21pc2UgZm9yIHRoZSBuZXh0IG9iamVjdCBmcm9tIHRoZSBjdXJzb3IsIHNraXBwaW5nIHRob3NlIHdob3NlXG4gIC8vIElEcyB3ZSd2ZSBhbHJlYWR5IHNlZW4gYW5kIHJlcGxhY2luZyBNb25nbyBhdG9tcyB3aXRoIE1ldGVvciBhdG9tcy5cbiAgX25leHRPYmplY3RQcm9taXNlOiBhc3luYyBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIHZhciBkb2MgPSBhd2FpdCBzZWxmLl9yYXdOZXh0T2JqZWN0UHJvbWlzZSgpO1xuXG4gICAgICBpZiAoIWRvYykgcmV0dXJuIG51bGw7XG4gICAgICBkb2MgPSByZXBsYWNlVHlwZXMoZG9jLCByZXBsYWNlTW9uZ29BdG9tV2l0aE1ldGVvcik7XG5cbiAgICAgIGlmICghc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50YWlsYWJsZSAmJiBfLmhhcyhkb2MsICdfaWQnKSkge1xuICAgICAgICAvLyBEaWQgTW9uZ28gZ2l2ZSB1cyBkdXBsaWNhdGUgZG9jdW1lbnRzIGluIHRoZSBzYW1lIGN1cnNvcj8gSWYgc28sXG4gICAgICAgIC8vIGlnbm9yZSB0aGlzIG9uZS4gKERvIHRoaXMgYmVmb3JlIHRoZSB0cmFuc2Zvcm0sIHNpbmNlIHRyYW5zZm9ybSBtaWdodFxuICAgICAgICAvLyByZXR1cm4gc29tZSB1bnJlbGF0ZWQgdmFsdWUuKSBXZSBkb24ndCBkbyB0aGlzIGZvciB0YWlsYWJsZSBjdXJzb3JzLFxuICAgICAgICAvLyBiZWNhdXNlIHdlIHdhbnQgdG8gbWFpbnRhaW4gTygxKSBtZW1vcnkgdXNhZ2UuIEFuZCBpZiB0aGVyZSBpc24ndCBfaWRcbiAgICAgICAgLy8gZm9yIHNvbWUgcmVhc29uIChtYXliZSBpdCdzIHRoZSBvcGxvZyksIHRoZW4gd2UgZG9uJ3QgZG8gdGhpcyBlaXRoZXIuXG4gICAgICAgIC8vIChCZSBjYXJlZnVsIHRvIGRvIHRoaXMgZm9yIGZhbHNleSBidXQgZXhpc3RpbmcgX2lkLCB0aG91Z2guKVxuICAgICAgICBpZiAoc2VsZi5fdmlzaXRlZElkcy5oYXMoZG9jLl9pZCkpIGNvbnRpbnVlO1xuICAgICAgICBzZWxmLl92aXNpdGVkSWRzLnNldChkb2MuX2lkLCB0cnVlKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHNlbGYuX3RyYW5zZm9ybSlcbiAgICAgICAgZG9jID0gc2VsZi5fdHJhbnNmb3JtKGRvYyk7XG5cbiAgICAgIHJldHVybiBkb2M7XG4gICAgfVxuICB9LFxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHdoaWNoIGlzIHJlc29sdmVkIHdpdGggdGhlIG5leHQgb2JqZWN0IChsaWtlIHdpdGhcbiAgLy8gX25leHRPYmplY3RQcm9taXNlKSBvciByZWplY3RlZCBpZiB0aGUgY3Vyc29yIGRvZXNuJ3QgcmV0dXJuIHdpdGhpblxuICAvLyB0aW1lb3V0TVMgbXMuXG4gIF9uZXh0T2JqZWN0UHJvbWlzZVdpdGhUaW1lb3V0OiBmdW5jdGlvbiAodGltZW91dE1TKSB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgaWYgKCF0aW1lb3V0TVMpIHtcbiAgICAgIHJldHVybiBzZWxmLl9uZXh0T2JqZWN0UHJvbWlzZSgpO1xuICAgIH1cbiAgICBjb25zdCBuZXh0T2JqZWN0UHJvbWlzZSA9IHNlbGYuX25leHRPYmplY3RQcm9taXNlKCk7XG4gICAgY29uc3QgdGltZW91dEVyciA9IG5ldyBFcnJvcignQ2xpZW50LXNpZGUgdGltZW91dCB3YWl0aW5nIGZvciBuZXh0IG9iamVjdCcpO1xuICAgIGNvbnN0IHRpbWVvdXRQcm9taXNlID0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgcmVqZWN0KHRpbWVvdXRFcnIpO1xuICAgICAgfSwgdGltZW91dE1TKTtcbiAgICB9KTtcbiAgICByZXR1cm4gUHJvbWlzZS5yYWNlKFtuZXh0T2JqZWN0UHJvbWlzZSwgdGltZW91dFByb21pc2VdKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgaWYgKGVyciA9PT0gdGltZW91dEVycikge1xuICAgICAgICAgIHNlbGYuY2xvc2UoKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9KTtcbiAgfSxcblxuICBfbmV4dE9iamVjdDogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICByZXR1cm4gc2VsZi5fbmV4dE9iamVjdFByb21pc2UoKS5hd2FpdCgpO1xuICB9LFxuXG4gIGZvckVhY2g6IGZ1bmN0aW9uIChjYWxsYmFjaywgdGhpc0FyZykge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIC8vIEdldCBiYWNrIHRvIHRoZSBiZWdpbm5pbmcuXG4gICAgc2VsZi5fcmV3aW5kKCk7XG5cbiAgICAvLyBXZSBpbXBsZW1lbnQgdGhlIGxvb3Agb3Vyc2VsZiBpbnN0ZWFkIG9mIHVzaW5nIHNlbGYuX2RiQ3Vyc29yLmVhY2gsXG4gICAgLy8gYmVjYXVzZSBcImVhY2hcIiB3aWxsIGNhbGwgaXRzIGNhbGxiYWNrIG91dHNpZGUgb2YgYSBmaWJlciB3aGljaCBtYWtlcyBpdFxuICAgIC8vIG11Y2ggbW9yZSBjb21wbGV4IHRvIG1ha2UgdGhpcyBmdW5jdGlvbiBzeW5jaHJvbm91cy5cbiAgICB2YXIgaW5kZXggPSAwO1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICB2YXIgZG9jID0gc2VsZi5fbmV4dE9iamVjdCgpO1xuICAgICAgaWYgKCFkb2MpIHJldHVybjtcbiAgICAgIGNhbGxiYWNrLmNhbGwodGhpc0FyZywgZG9jLCBpbmRleCsrLCBzZWxmLl9zZWxmRm9ySXRlcmF0aW9uKTtcbiAgICB9XG4gIH0sXG5cbiAgLy8gWFhYIEFsbG93IG92ZXJsYXBwaW5nIGNhbGxiYWNrIGV4ZWN1dGlvbnMgaWYgY2FsbGJhY2sgeWllbGRzLlxuICBtYXA6IGZ1bmN0aW9uIChjYWxsYmFjaywgdGhpc0FyZykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB2YXIgcmVzID0gW107XG4gICAgc2VsZi5mb3JFYWNoKGZ1bmN0aW9uIChkb2MsIGluZGV4KSB7XG4gICAgICByZXMucHVzaChjYWxsYmFjay5jYWxsKHRoaXNBcmcsIGRvYywgaW5kZXgsIHNlbGYuX3NlbGZGb3JJdGVyYXRpb24pKTtcbiAgICB9KTtcbiAgICByZXR1cm4gcmVzO1xuICB9LFxuXG4gIF9yZXdpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICAvLyBrbm93biB0byBiZSBzeW5jaHJvbm91c1xuICAgIHNlbGYuX2RiQ3Vyc29yLnJld2luZCgpO1xuXG4gICAgc2VsZi5fdmlzaXRlZElkcyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICB9LFxuXG4gIC8vIE1vc3RseSB1c2FibGUgZm9yIHRhaWxhYmxlIGN1cnNvcnMuXG4gIGNsb3NlOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgc2VsZi5fZGJDdXJzb3IuY2xvc2UoKTtcbiAgfSxcblxuICBmZXRjaDogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICByZXR1cm4gc2VsZi5tYXAoXy5pZGVudGl0eSk7XG4gIH0sXG5cbiAgY291bnQ6IGZ1bmN0aW9uIChhcHBseVNraXBMaW1pdCA9IGZhbHNlKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiBzZWxmLl9zeW5jaHJvbm91c0NvdW50KGFwcGx5U2tpcExpbWl0KS53YWl0KCk7XG4gIH0sXG5cbiAgLy8gVGhpcyBtZXRob2QgaXMgTk9UIHdyYXBwZWQgaW4gQ3Vyc29yLlxuICBnZXRSYXdPYmplY3RzOiBmdW5jdGlvbiAob3JkZXJlZCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAob3JkZXJlZCkge1xuICAgICAgcmV0dXJuIHNlbGYuZmV0Y2goKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdmFyIHJlc3VsdHMgPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcDtcbiAgICAgIHNlbGYuZm9yRWFjaChmdW5jdGlvbiAoZG9jKSB7XG4gICAgICAgIHJlc3VsdHMuc2V0KGRvYy5faWQsIGRvYyk7XG4gICAgICB9KTtcbiAgICAgIHJldHVybiByZXN1bHRzO1xuICAgIH1cbiAgfVxufSk7XG5cblN5bmNocm9ub3VzQ3Vyc29yLnByb3RvdHlwZVtTeW1ib2wuaXRlcmF0b3JdID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgLy8gR2V0IGJhY2sgdG8gdGhlIGJlZ2lubmluZy5cbiAgc2VsZi5fcmV3aW5kKCk7XG5cbiAgcmV0dXJuIHtcbiAgICBuZXh0KCkge1xuICAgICAgY29uc3QgZG9jID0gc2VsZi5fbmV4dE9iamVjdCgpO1xuICAgICAgcmV0dXJuIGRvYyA/IHtcbiAgICAgICAgdmFsdWU6IGRvY1xuICAgICAgfSA6IHtcbiAgICAgICAgZG9uZTogdHJ1ZVxuICAgICAgfTtcbiAgICB9XG4gIH07XG59O1xuXG4vLyBUYWlscyB0aGUgY3Vyc29yIGRlc2NyaWJlZCBieSBjdXJzb3JEZXNjcmlwdGlvbiwgbW9zdCBsaWtlbHkgb24gdGhlXG4vLyBvcGxvZy4gQ2FsbHMgZG9jQ2FsbGJhY2sgd2l0aCBlYWNoIGRvY3VtZW50IGZvdW5kLiBJZ25vcmVzIGVycm9ycyBhbmQganVzdFxuLy8gcmVzdGFydHMgdGhlIHRhaWwgb24gZXJyb3IuXG4vL1xuLy8gSWYgdGltZW91dE1TIGlzIHNldCwgdGhlbiBpZiB3ZSBkb24ndCBnZXQgYSBuZXcgZG9jdW1lbnQgZXZlcnkgdGltZW91dE1TLFxuLy8ga2lsbCBhbmQgcmVzdGFydCB0aGUgY3Vyc29yLiBUaGlzIGlzIHByaW1hcmlseSBhIHdvcmthcm91bmQgZm9yICM4NTk4LlxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS50YWlsID0gZnVuY3Rpb24gKGN1cnNvckRlc2NyaXB0aW9uLCBkb2NDYWxsYmFjaywgdGltZW91dE1TKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgaWYgKCFjdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLnRhaWxhYmxlKVxuICAgIHRocm93IG5ldyBFcnJvcihcIkNhbiBvbmx5IHRhaWwgYSB0YWlsYWJsZSBjdXJzb3JcIik7XG5cbiAgdmFyIGN1cnNvciA9IHNlbGYuX2NyZWF0ZVN5bmNocm9ub3VzQ3Vyc29yKGN1cnNvckRlc2NyaXB0aW9uKTtcblxuICB2YXIgc3RvcHBlZCA9IGZhbHNlO1xuICB2YXIgbGFzdFRTO1xuICB2YXIgbG9vcCA9IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgZG9jID0gbnVsbDtcbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgaWYgKHN0b3BwZWQpXG4gICAgICAgIHJldHVybjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGRvYyA9IGN1cnNvci5fbmV4dE9iamVjdFByb21pc2VXaXRoVGltZW91dCh0aW1lb3V0TVMpLmF3YWl0KCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgLy8gVGhlcmUncyBubyBnb29kIHdheSB0byBmaWd1cmUgb3V0IGlmIHRoaXMgd2FzIGFjdHVhbGx5IGFuIGVycm9yIGZyb21cbiAgICAgICAgLy8gTW9uZ28sIG9yIGp1c3QgY2xpZW50LXNpZGUgKGluY2x1ZGluZyBvdXIgb3duIHRpbWVvdXQgZXJyb3IpLiBBaFxuICAgICAgICAvLyB3ZWxsLiBCdXQgZWl0aGVyIHdheSwgd2UgbmVlZCB0byByZXRyeSB0aGUgY3Vyc29yICh1bmxlc3MgdGhlIGZhaWx1cmVcbiAgICAgICAgLy8gd2FzIGJlY2F1c2UgdGhlIG9ic2VydmUgZ290IHN0b3BwZWQpLlxuICAgICAgICBkb2MgPSBudWxsO1xuICAgICAgfVxuICAgICAgLy8gU2luY2Ugd2UgYXdhaXRlZCBhIHByb21pc2UgYWJvdmUsIHdlIG5lZWQgdG8gY2hlY2sgYWdhaW4gdG8gc2VlIGlmXG4gICAgICAvLyB3ZSd2ZSBiZWVuIHN0b3BwZWQgYmVmb3JlIGNhbGxpbmcgdGhlIGNhbGxiYWNrLlxuICAgICAgaWYgKHN0b3BwZWQpXG4gICAgICAgIHJldHVybjtcbiAgICAgIGlmIChkb2MpIHtcbiAgICAgICAgLy8gSWYgYSB0YWlsYWJsZSBjdXJzb3IgY29udGFpbnMgYSBcInRzXCIgZmllbGQsIHVzZSBpdCB0byByZWNyZWF0ZSB0aGVcbiAgICAgICAgLy8gY3Vyc29yIG9uIGVycm9yLiAoXCJ0c1wiIGlzIGEgc3RhbmRhcmQgdGhhdCBNb25nbyB1c2VzIGludGVybmFsbHkgZm9yXG4gICAgICAgIC8vIHRoZSBvcGxvZywgYW5kIHRoZXJlJ3MgYSBzcGVjaWFsIGZsYWcgdGhhdCBsZXRzIHlvdSBkbyBiaW5hcnkgc2VhcmNoXG4gICAgICAgIC8vIG9uIGl0IGluc3RlYWQgb2YgbmVlZGluZyB0byB1c2UgYW4gaW5kZXguKVxuICAgICAgICBsYXN0VFMgPSBkb2MudHM7XG4gICAgICAgIGRvY0NhbGxiYWNrKGRvYyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgbmV3U2VsZWN0b3IgPSBfLmNsb25lKGN1cnNvckRlc2NyaXB0aW9uLnNlbGVjdG9yKTtcbiAgICAgICAgaWYgKGxhc3RUUykge1xuICAgICAgICAgIG5ld1NlbGVjdG9yLnRzID0geyRndDogbGFzdFRTfTtcbiAgICAgICAgfVxuICAgICAgICBjdXJzb3IgPSBzZWxmLl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvcihuZXcgQ3Vyc29yRGVzY3JpcHRpb24oXG4gICAgICAgICAgY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWUsXG4gICAgICAgICAgbmV3U2VsZWN0b3IsXG4gICAgICAgICAgY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucykpO1xuICAgICAgICAvLyBNb25nbyBmYWlsb3ZlciB0YWtlcyBtYW55IHNlY29uZHMuICBSZXRyeSBpbiBhIGJpdC4gIChXaXRob3V0IHRoaXNcbiAgICAgICAgLy8gc2V0VGltZW91dCwgd2UgcGVnIHRoZSBDUFUgYXQgMTAwJSBhbmQgbmV2ZXIgbm90aWNlIHRoZSBhY3R1YWxcbiAgICAgICAgLy8gZmFpbG92ZXIuXG4gICAgICAgIE1ldGVvci5zZXRUaW1lb3V0KGxvb3AsIDEwMCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBNZXRlb3IuZGVmZXIobG9vcCk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICAgIGN1cnNvci5jbG9zZSgpO1xuICAgIH1cbiAgfTtcbn07XG5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX29ic2VydmVDaGFuZ2VzID0gZnVuY3Rpb24gKFxuICAgIGN1cnNvckRlc2NyaXB0aW9uLCBvcmRlcmVkLCBjYWxsYmFja3MpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIGlmIChjdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLnRhaWxhYmxlKSB7XG4gICAgcmV0dXJuIHNlbGYuX29ic2VydmVDaGFuZ2VzVGFpbGFibGUoY3Vyc29yRGVzY3JpcHRpb24sIG9yZGVyZWQsIGNhbGxiYWNrcyk7XG4gIH1cblxuICAvLyBZb3UgbWF5IG5vdCBmaWx0ZXIgb3V0IF9pZCB3aGVuIG9ic2VydmluZyBjaGFuZ2VzLCBiZWNhdXNlIHRoZSBpZCBpcyBhIGNvcmVcbiAgLy8gcGFydCBvZiB0aGUgb2JzZXJ2ZUNoYW5nZXMgQVBJLlxuICBpZiAoY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5maWVsZHMgJiZcbiAgICAgIChjdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLmZpZWxkcy5faWQgPT09IDAgfHxcbiAgICAgICBjdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLmZpZWxkcy5faWQgPT09IGZhbHNlKSkge1xuICAgIHRocm93IEVycm9yKFwiWW91IG1heSBub3Qgb2JzZXJ2ZSBhIGN1cnNvciB3aXRoIHtmaWVsZHM6IHtfaWQ6IDB9fVwiKTtcbiAgfVxuXG4gIHZhciBvYnNlcnZlS2V5ID0gRUpTT04uc3RyaW5naWZ5KFxuICAgIF8uZXh0ZW5kKHtvcmRlcmVkOiBvcmRlcmVkfSwgY3Vyc29yRGVzY3JpcHRpb24pKTtcblxuICB2YXIgbXVsdGlwbGV4ZXIsIG9ic2VydmVEcml2ZXI7XG4gIHZhciBmaXJzdEhhbmRsZSA9IGZhbHNlO1xuXG4gIC8vIEZpbmQgYSBtYXRjaGluZyBPYnNlcnZlTXVsdGlwbGV4ZXIsIG9yIGNyZWF0ZSBhIG5ldyBvbmUuIFRoaXMgbmV4dCBibG9jayBpc1xuICAvLyBndWFyYW50ZWVkIHRvIG5vdCB5aWVsZCAoYW5kIGl0IGRvZXNuJ3QgY2FsbCBhbnl0aGluZyB0aGF0IGNhbiBvYnNlcnZlIGFcbiAgLy8gbmV3IHF1ZXJ5KSwgc28gbm8gb3RoZXIgY2FsbHMgdG8gdGhpcyBmdW5jdGlvbiBjYW4gaW50ZXJsZWF2ZSB3aXRoIGl0LlxuICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgaWYgKF8uaGFzKHNlbGYuX29ic2VydmVNdWx0aXBsZXhlcnMsIG9ic2VydmVLZXkpKSB7XG4gICAgICBtdWx0aXBsZXhlciA9IHNlbGYuX29ic2VydmVNdWx0aXBsZXhlcnNbb2JzZXJ2ZUtleV07XG4gICAgfSBlbHNlIHtcbiAgICAgIGZpcnN0SGFuZGxlID0gdHJ1ZTtcbiAgICAgIC8vIENyZWF0ZSBhIG5ldyBPYnNlcnZlTXVsdGlwbGV4ZXIuXG4gICAgICBtdWx0aXBsZXhlciA9IG5ldyBPYnNlcnZlTXVsdGlwbGV4ZXIoe1xuICAgICAgICBvcmRlcmVkOiBvcmRlcmVkLFxuICAgICAgICBvblN0b3A6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBkZWxldGUgc2VsZi5fb2JzZXJ2ZU11bHRpcGxleGVyc1tvYnNlcnZlS2V5XTtcbiAgICAgICAgICBvYnNlcnZlRHJpdmVyLnN0b3AoKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBzZWxmLl9vYnNlcnZlTXVsdGlwbGV4ZXJzW29ic2VydmVLZXldID0gbXVsdGlwbGV4ZXI7XG4gICAgfVxuICB9KTtcblxuICB2YXIgb2JzZXJ2ZUhhbmRsZSA9IG5ldyBPYnNlcnZlSGFuZGxlKG11bHRpcGxleGVyLCBjYWxsYmFja3MpO1xuXG4gIGlmIChmaXJzdEhhbmRsZSkge1xuICAgIHZhciBtYXRjaGVyLCBzb3J0ZXI7XG4gICAgdmFyIGNhblVzZU9wbG9nID0gXy5hbGwoW1xuICAgICAgZnVuY3Rpb24gKCkge1xuICAgICAgICAvLyBBdCBhIGJhcmUgbWluaW11bSwgdXNpbmcgdGhlIG9wbG9nIHJlcXVpcmVzIHVzIHRvIGhhdmUgYW4gb3Bsb2csIHRvXG4gICAgICAgIC8vIHdhbnQgdW5vcmRlcmVkIGNhbGxiYWNrcywgYW5kIHRvIG5vdCB3YW50IGEgY2FsbGJhY2sgb24gdGhlIHBvbGxzXG4gICAgICAgIC8vIHRoYXQgd29uJ3QgaGFwcGVuLlxuICAgICAgICByZXR1cm4gc2VsZi5fb3Bsb2dIYW5kbGUgJiYgIW9yZGVyZWQgJiZcbiAgICAgICAgICAhY2FsbGJhY2tzLl90ZXN0T25seVBvbGxDYWxsYmFjaztcbiAgICAgIH0sIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgLy8gV2UgbmVlZCB0byBiZSBhYmxlIHRvIGNvbXBpbGUgdGhlIHNlbGVjdG9yLiBGYWxsIGJhY2sgdG8gcG9sbGluZyBmb3JcbiAgICAgICAgLy8gc29tZSBuZXdmYW5nbGVkICRzZWxlY3RvciB0aGF0IG1pbmltb25nbyBkb2Vzbid0IHN1cHBvcnQgeWV0LlxuICAgICAgICB0cnkge1xuICAgICAgICAgIG1hdGNoZXIgPSBuZXcgTWluaW1vbmdvLk1hdGNoZXIoY3Vyc29yRGVzY3JpcHRpb24uc2VsZWN0b3IpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgLy8gWFhYIG1ha2UgYWxsIGNvbXBpbGF0aW9uIGVycm9ycyBNaW5pbW9uZ29FcnJvciBvciBzb21ldGhpbmdcbiAgICAgICAgICAvLyAgICAgc28gdGhhdCB0aGlzIGRvZXNuJ3QgaWdub3JlIHVucmVsYXRlZCBleGNlcHRpb25zXG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9LCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIC8vIC4uLiBhbmQgdGhlIHNlbGVjdG9yIGl0c2VsZiBuZWVkcyB0byBzdXBwb3J0IG9wbG9nLlxuICAgICAgICByZXR1cm4gT3Bsb2dPYnNlcnZlRHJpdmVyLmN1cnNvclN1cHBvcnRlZChjdXJzb3JEZXNjcmlwdGlvbiwgbWF0Y2hlcik7XG4gICAgICB9LCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIC8vIEFuZCB3ZSBuZWVkIHRvIGJlIGFibGUgdG8gY29tcGlsZSB0aGUgc29ydCwgaWYgYW55LiAgZWcsIGNhbid0IGJlXG4gICAgICAgIC8vIHskbmF0dXJhbDogMX0uXG4gICAgICAgIGlmICghY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5zb3J0KVxuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHNvcnRlciA9IG5ldyBNaW5pbW9uZ28uU29ydGVyKGN1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMuc29ydCk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBYWFggbWFrZSBhbGwgY29tcGlsYXRpb24gZXJyb3JzIE1pbmltb25nb0Vycm9yIG9yIHNvbWV0aGluZ1xuICAgICAgICAgIC8vICAgICBzbyB0aGF0IHRoaXMgZG9lc24ndCBpZ25vcmUgdW5yZWxhdGVkIGV4Y2VwdGlvbnNcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1dLCBmdW5jdGlvbiAoZikgeyByZXR1cm4gZigpOyB9KTsgIC8vIGludm9rZSBlYWNoIGZ1bmN0aW9uXG5cbiAgICB2YXIgZHJpdmVyQ2xhc3MgPSBjYW5Vc2VPcGxvZyA/IE9wbG9nT2JzZXJ2ZURyaXZlciA6IFBvbGxpbmdPYnNlcnZlRHJpdmVyO1xuICAgIG9ic2VydmVEcml2ZXIgPSBuZXcgZHJpdmVyQ2xhc3Moe1xuICAgICAgY3Vyc29yRGVzY3JpcHRpb246IGN1cnNvckRlc2NyaXB0aW9uLFxuICAgICAgbW9uZ29IYW5kbGU6IHNlbGYsXG4gICAgICBtdWx0aXBsZXhlcjogbXVsdGlwbGV4ZXIsXG4gICAgICBvcmRlcmVkOiBvcmRlcmVkLFxuICAgICAgbWF0Y2hlcjogbWF0Y2hlciwgIC8vIGlnbm9yZWQgYnkgcG9sbGluZ1xuICAgICAgc29ydGVyOiBzb3J0ZXIsICAvLyBpZ25vcmVkIGJ5IHBvbGxpbmdcbiAgICAgIF90ZXN0T25seVBvbGxDYWxsYmFjazogY2FsbGJhY2tzLl90ZXN0T25seVBvbGxDYWxsYmFja1xuICAgIH0pO1xuXG4gICAgLy8gVGhpcyBmaWVsZCBpcyBvbmx5IHNldCBmb3IgdXNlIGluIHRlc3RzLlxuICAgIG11bHRpcGxleGVyLl9vYnNlcnZlRHJpdmVyID0gb2JzZXJ2ZURyaXZlcjtcbiAgfVxuXG4gIC8vIEJsb2NrcyB1bnRpbCB0aGUgaW5pdGlhbCBhZGRzIGhhdmUgYmVlbiBzZW50LlxuICBtdWx0aXBsZXhlci5hZGRIYW5kbGVBbmRTZW5kSW5pdGlhbEFkZHMob2JzZXJ2ZUhhbmRsZSk7XG5cbiAgcmV0dXJuIG9ic2VydmVIYW5kbGU7XG59O1xuXG4vLyBMaXN0ZW4gZm9yIHRoZSBpbnZhbGlkYXRpb24gbWVzc2FnZXMgdGhhdCB3aWxsIHRyaWdnZXIgdXMgdG8gcG9sbCB0aGVcbi8vIGRhdGFiYXNlIGZvciBjaGFuZ2VzLiBJZiB0aGlzIHNlbGVjdG9yIHNwZWNpZmllcyBzcGVjaWZpYyBJRHMsIHNwZWNpZnkgdGhlbVxuLy8gaGVyZSwgc28gdGhhdCB1cGRhdGVzIHRvIGRpZmZlcmVudCBzcGVjaWZpYyBJRHMgZG9uJ3QgY2F1c2UgdXMgdG8gcG9sbC5cbi8vIGxpc3RlbkNhbGxiYWNrIGlzIHRoZSBzYW1lIGtpbmQgb2YgKG5vdGlmaWNhdGlvbiwgY29tcGxldGUpIGNhbGxiYWNrIHBhc3NlZFxuLy8gdG8gSW52YWxpZGF0aW9uQ3Jvc3NiYXIubGlzdGVuLlxuXG5saXN0ZW5BbGwgPSBmdW5jdGlvbiAoY3Vyc29yRGVzY3JpcHRpb24sIGxpc3RlbkNhbGxiYWNrKSB7XG4gIHZhciBsaXN0ZW5lcnMgPSBbXTtcbiAgZm9yRWFjaFRyaWdnZXIoY3Vyc29yRGVzY3JpcHRpb24sIGZ1bmN0aW9uICh0cmlnZ2VyKSB7XG4gICAgbGlzdGVuZXJzLnB1c2goRERQU2VydmVyLl9JbnZhbGlkYXRpb25Dcm9zc2Jhci5saXN0ZW4oXG4gICAgICB0cmlnZ2VyLCBsaXN0ZW5DYWxsYmFjaykpO1xuICB9KTtcblxuICByZXR1cm4ge1xuICAgIHN0b3A6IGZ1bmN0aW9uICgpIHtcbiAgICAgIF8uZWFjaChsaXN0ZW5lcnMsIGZ1bmN0aW9uIChsaXN0ZW5lcikge1xuICAgICAgICBsaXN0ZW5lci5zdG9wKCk7XG4gICAgICB9KTtcbiAgICB9XG4gIH07XG59O1xuXG5mb3JFYWNoVHJpZ2dlciA9IGZ1bmN0aW9uIChjdXJzb3JEZXNjcmlwdGlvbiwgdHJpZ2dlckNhbGxiYWNrKSB7XG4gIHZhciBrZXkgPSB7Y29sbGVjdGlvbjogY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWV9O1xuICB2YXIgc3BlY2lmaWNJZHMgPSBMb2NhbENvbGxlY3Rpb24uX2lkc01hdGNoZWRCeVNlbGVjdG9yKFxuICAgIGN1cnNvckRlc2NyaXB0aW9uLnNlbGVjdG9yKTtcbiAgaWYgKHNwZWNpZmljSWRzKSB7XG4gICAgXy5lYWNoKHNwZWNpZmljSWRzLCBmdW5jdGlvbiAoaWQpIHtcbiAgICAgIHRyaWdnZXJDYWxsYmFjayhfLmV4dGVuZCh7aWQ6IGlkfSwga2V5KSk7XG4gICAgfSk7XG4gICAgdHJpZ2dlckNhbGxiYWNrKF8uZXh0ZW5kKHtkcm9wQ29sbGVjdGlvbjogdHJ1ZSwgaWQ6IG51bGx9LCBrZXkpKTtcbiAgfSBlbHNlIHtcbiAgICB0cmlnZ2VyQ2FsbGJhY2soa2V5KTtcbiAgfVxuICAvLyBFdmVyeW9uZSBjYXJlcyBhYm91dCB0aGUgZGF0YWJhc2UgYmVpbmcgZHJvcHBlZC5cbiAgdHJpZ2dlckNhbGxiYWNrKHsgZHJvcERhdGFiYXNlOiB0cnVlIH0pO1xufTtcblxuLy8gb2JzZXJ2ZUNoYW5nZXMgZm9yIHRhaWxhYmxlIGN1cnNvcnMgb24gY2FwcGVkIGNvbGxlY3Rpb25zLlxuLy9cbi8vIFNvbWUgZGlmZmVyZW5jZXMgZnJvbSBub3JtYWwgY3Vyc29yczpcbi8vICAgLSBXaWxsIG5ldmVyIHByb2R1Y2UgYW55dGhpbmcgb3RoZXIgdGhhbiAnYWRkZWQnIG9yICdhZGRlZEJlZm9yZScuIElmIHlvdVxuLy8gICAgIGRvIHVwZGF0ZSBhIGRvY3VtZW50IHRoYXQgaGFzIGFscmVhZHkgYmVlbiBwcm9kdWNlZCwgdGhpcyB3aWxsIG5vdCBub3RpY2Vcbi8vICAgICBpdC5cbi8vICAgLSBJZiB5b3UgZGlzY29ubmVjdCBhbmQgcmVjb25uZWN0IGZyb20gTW9uZ28sIGl0IHdpbGwgZXNzZW50aWFsbHkgcmVzdGFydFxuLy8gICAgIHRoZSBxdWVyeSwgd2hpY2ggd2lsbCBsZWFkIHRvIGR1cGxpY2F0ZSByZXN1bHRzLiBUaGlzIGlzIHByZXR0eSBiYWQsXG4vLyAgICAgYnV0IGlmIHlvdSBpbmNsdWRlIGEgZmllbGQgY2FsbGVkICd0cycgd2hpY2ggaXMgaW5zZXJ0ZWQgYXNcbi8vICAgICBuZXcgTW9uZ29JbnRlcm5hbHMuTW9uZ29UaW1lc3RhbXAoMCwgMCkgKHdoaWNoIGlzIGluaXRpYWxpemVkIHRvIHRoZVxuLy8gICAgIGN1cnJlbnQgTW9uZ28tc3R5bGUgdGltZXN0YW1wKSwgd2UnbGwgYmUgYWJsZSB0byBmaW5kIHRoZSBwbGFjZSB0b1xuLy8gICAgIHJlc3RhcnQgcHJvcGVybHkuIChUaGlzIGZpZWxkIGlzIHNwZWNpZmljYWxseSB1bmRlcnN0b29kIGJ5IE1vbmdvIHdpdGggYW5cbi8vICAgICBvcHRpbWl6YXRpb24gd2hpY2ggYWxsb3dzIGl0IHRvIGZpbmQgdGhlIHJpZ2h0IHBsYWNlIHRvIHN0YXJ0IHdpdGhvdXRcbi8vICAgICBhbiBpbmRleCBvbiB0cy4gSXQncyBob3cgdGhlIG9wbG9nIHdvcmtzLilcbi8vICAgLSBObyBjYWxsYmFja3MgYXJlIHRyaWdnZXJlZCBzeW5jaHJvbm91c2x5IHdpdGggdGhlIGNhbGwgKHRoZXJlJ3Mgbm9cbi8vICAgICBkaWZmZXJlbnRpYXRpb24gYmV0d2VlbiBcImluaXRpYWwgZGF0YVwiIGFuZCBcImxhdGVyIGNoYW5nZXNcIjsgZXZlcnl0aGluZ1xuLy8gICAgIHRoYXQgbWF0Y2hlcyB0aGUgcXVlcnkgZ2V0cyBzZW50IGFzeW5jaHJvbm91c2x5KS5cbi8vICAgLSBEZS1kdXBsaWNhdGlvbiBpcyBub3QgaW1wbGVtZW50ZWQuXG4vLyAgIC0gRG9lcyBub3QgeWV0IGludGVyYWN0IHdpdGggdGhlIHdyaXRlIGZlbmNlLiBQcm9iYWJseSwgdGhpcyBzaG91bGQgd29yayBieVxuLy8gICAgIGlnbm9yaW5nIHJlbW92ZXMgKHdoaWNoIGRvbid0IHdvcmsgb24gY2FwcGVkIGNvbGxlY3Rpb25zKSBhbmQgdXBkYXRlc1xuLy8gICAgICh3aGljaCBkb24ndCBhZmZlY3QgdGFpbGFibGUgY3Vyc29ycyksIGFuZCBqdXN0IGtlZXBpbmcgdHJhY2sgb2YgdGhlIElEXG4vLyAgICAgb2YgdGhlIGluc2VydGVkIG9iamVjdCwgYW5kIGNsb3NpbmcgdGhlIHdyaXRlIGZlbmNlIG9uY2UgeW91IGdldCB0byB0aGF0XG4vLyAgICAgSUQgKG9yIHRpbWVzdGFtcD8pLiAgVGhpcyBkb2Vzbid0IHdvcmsgd2VsbCBpZiB0aGUgZG9jdW1lbnQgZG9lc24ndCBtYXRjaFxuLy8gICAgIHRoZSBxdWVyeSwgdGhvdWdoLiAgT24gdGhlIG90aGVyIGhhbmQsIHRoZSB3cml0ZSBmZW5jZSBjYW4gY2xvc2Vcbi8vICAgICBpbW1lZGlhdGVseSBpZiBpdCBkb2VzIG5vdCBtYXRjaCB0aGUgcXVlcnkuIFNvIGlmIHdlIHRydXN0IG1pbmltb25nb1xuLy8gICAgIGVub3VnaCB0byBhY2N1cmF0ZWx5IGV2YWx1YXRlIHRoZSBxdWVyeSBhZ2FpbnN0IHRoZSB3cml0ZSBmZW5jZSwgd2Vcbi8vICAgICBzaG91bGQgYmUgYWJsZSB0byBkbyB0aGlzLi4uICBPZiBjb3Vyc2UsIG1pbmltb25nbyBkb2Vzbid0IGV2ZW4gc3VwcG9ydFxuLy8gICAgIE1vbmdvIFRpbWVzdGFtcHMgeWV0LlxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5fb2JzZXJ2ZUNoYW5nZXNUYWlsYWJsZSA9IGZ1bmN0aW9uIChcbiAgICBjdXJzb3JEZXNjcmlwdGlvbiwgb3JkZXJlZCwgY2FsbGJhY2tzKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICAvLyBUYWlsYWJsZSBjdXJzb3JzIG9ubHkgZXZlciBjYWxsIGFkZGVkL2FkZGVkQmVmb3JlIGNhbGxiYWNrcywgc28gaXQncyBhblxuICAvLyBlcnJvciBpZiB5b3UgZGlkbid0IHByb3ZpZGUgdGhlbS5cbiAgaWYgKChvcmRlcmVkICYmICFjYWxsYmFja3MuYWRkZWRCZWZvcmUpIHx8XG4gICAgICAoIW9yZGVyZWQgJiYgIWNhbGxiYWNrcy5hZGRlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4ndCBvYnNlcnZlIGFuIFwiICsgKG9yZGVyZWQgPyBcIm9yZGVyZWRcIiA6IFwidW5vcmRlcmVkXCIpXG4gICAgICAgICAgICAgICAgICAgICsgXCIgdGFpbGFibGUgY3Vyc29yIHdpdGhvdXQgYSBcIlxuICAgICAgICAgICAgICAgICAgICArIChvcmRlcmVkID8gXCJhZGRlZEJlZm9yZVwiIDogXCJhZGRlZFwiKSArIFwiIGNhbGxiYWNrXCIpO1xuICB9XG5cbiAgcmV0dXJuIHNlbGYudGFpbChjdXJzb3JEZXNjcmlwdGlvbiwgZnVuY3Rpb24gKGRvYykge1xuICAgIHZhciBpZCA9IGRvYy5faWQ7XG4gICAgZGVsZXRlIGRvYy5faWQ7XG4gICAgLy8gVGhlIHRzIGlzIGFuIGltcGxlbWVudGF0aW9uIGRldGFpbC4gSGlkZSBpdC5cbiAgICBkZWxldGUgZG9jLnRzO1xuICAgIGlmIChvcmRlcmVkKSB7XG4gICAgICBjYWxsYmFja3MuYWRkZWRCZWZvcmUoaWQsIGRvYywgbnVsbCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNhbGxiYWNrcy5hZGRlZChpZCwgZG9jKTtcbiAgICB9XG4gIH0pO1xufTtcblxuLy8gWFhYIFdlIHByb2JhYmx5IG5lZWQgdG8gZmluZCBhIGJldHRlciB3YXkgdG8gZXhwb3NlIHRoaXMuIFJpZ2h0IG5vd1xuLy8gaXQncyBvbmx5IHVzZWQgYnkgdGVzdHMsIGJ1dCBpbiBmYWN0IHlvdSBuZWVkIGl0IGluIG5vcm1hbFxuLy8gb3BlcmF0aW9uIHRvIGludGVyYWN0IHdpdGggY2FwcGVkIGNvbGxlY3Rpb25zLlxuTW9uZ29JbnRlcm5hbHMuTW9uZ29UaW1lc3RhbXAgPSBNb25nb0RCLlRpbWVzdGFtcDtcblxuTW9uZ29JbnRlcm5hbHMuQ29ubmVjdGlvbiA9IE1vbmdvQ29ubmVjdGlvbjtcbiIsInZhciBGdXR1cmUgPSBOcG0ucmVxdWlyZSgnZmliZXJzL2Z1dHVyZScpO1xuXG5pbXBvcnQgeyBOcG1Nb2R1bGVNb25nb2RiIH0gZnJvbSBcIm1ldGVvci9ucG0tbW9uZ29cIjtcbmNvbnN0IHsgVGltZXN0YW1wIH0gPSBOcG1Nb2R1bGVNb25nb2RiO1xuXG5PUExPR19DT0xMRUNUSU9OID0gJ29wbG9nLnJzJztcblxudmFyIFRPT19GQVJfQkVISU5EID0gcHJvY2Vzcy5lbnYuTUVURU9SX09QTE9HX1RPT19GQVJfQkVISU5EIHx8IDIwMDA7XG52YXIgVEFJTF9USU1FT1VUID0gK3Byb2Nlc3MuZW52Lk1FVEVPUl9PUExPR19UQUlMX1RJTUVPVVQgfHwgMzAwMDA7XG5cbnZhciBzaG93VFMgPSBmdW5jdGlvbiAodHMpIHtcbiAgcmV0dXJuIFwiVGltZXN0YW1wKFwiICsgdHMuZ2V0SGlnaEJpdHMoKSArIFwiLCBcIiArIHRzLmdldExvd0JpdHMoKSArIFwiKVwiO1xufTtcblxuaWRGb3JPcCA9IGZ1bmN0aW9uIChvcCkge1xuICBpZiAob3Aub3AgPT09ICdkJylcbiAgICByZXR1cm4gb3Auby5faWQ7XG4gIGVsc2UgaWYgKG9wLm9wID09PSAnaScpXG4gICAgcmV0dXJuIG9wLm8uX2lkO1xuICBlbHNlIGlmIChvcC5vcCA9PT0gJ3UnKVxuICAgIHJldHVybiBvcC5vMi5faWQ7XG4gIGVsc2UgaWYgKG9wLm9wID09PSAnYycpXG4gICAgdGhyb3cgRXJyb3IoXCJPcGVyYXRvciAnYycgZG9lc24ndCBzdXBwbHkgYW4gb2JqZWN0IHdpdGggaWQ6IFwiICtcbiAgICAgICAgICAgICAgICBFSlNPTi5zdHJpbmdpZnkob3ApKTtcbiAgZWxzZVxuICAgIHRocm93IEVycm9yKFwiVW5rbm93biBvcDogXCIgKyBFSlNPTi5zdHJpbmdpZnkob3ApKTtcbn07XG5cbk9wbG9nSGFuZGxlID0gZnVuY3Rpb24gKG9wbG9nVXJsLCBkYk5hbWUpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBzZWxmLl9vcGxvZ1VybCA9IG9wbG9nVXJsO1xuICBzZWxmLl9kYk5hbWUgPSBkYk5hbWU7XG5cbiAgc2VsZi5fb3Bsb2dMYXN0RW50cnlDb25uZWN0aW9uID0gbnVsbDtcbiAgc2VsZi5fb3Bsb2dUYWlsQ29ubmVjdGlvbiA9IG51bGw7XG4gIHNlbGYuX3N0b3BwZWQgPSBmYWxzZTtcbiAgc2VsZi5fdGFpbEhhbmRsZSA9IG51bGw7XG4gIHNlbGYuX3JlYWR5RnV0dXJlID0gbmV3IEZ1dHVyZSgpO1xuICBzZWxmLl9jcm9zc2JhciA9IG5ldyBERFBTZXJ2ZXIuX0Nyb3NzYmFyKHtcbiAgICBmYWN0UGFja2FnZTogXCJtb25nby1saXZlZGF0YVwiLCBmYWN0TmFtZTogXCJvcGxvZy13YXRjaGVyc1wiXG4gIH0pO1xuICBzZWxmLl9iYXNlT3Bsb2dTZWxlY3RvciA9IHtcbiAgICBuczogbmV3IFJlZ0V4cChcIl4oPzpcIiArIFtcbiAgICAgIE1ldGVvci5fZXNjYXBlUmVnRXhwKHNlbGYuX2RiTmFtZSArIFwiLlwiKSxcbiAgICAgIE1ldGVvci5fZXNjYXBlUmVnRXhwKFwiYWRtaW4uJGNtZFwiKSxcbiAgICBdLmpvaW4oXCJ8XCIpICsgXCIpXCIpLFxuXG4gICAgJG9yOiBbXG4gICAgICB7IG9wOiB7ICRpbjogWydpJywgJ3UnLCAnZCddIH0gfSxcbiAgICAgIC8vIGRyb3AgY29sbGVjdGlvblxuICAgICAgeyBvcDogJ2MnLCAnby5kcm9wJzogeyAkZXhpc3RzOiB0cnVlIH0gfSxcbiAgICAgIHsgb3A6ICdjJywgJ28uZHJvcERhdGFiYXNlJzogMSB9LFxuICAgICAgeyBvcDogJ2MnLCAnby5hcHBseU9wcyc6IHsgJGV4aXN0czogdHJ1ZSB9IH0sXG4gICAgXVxuICB9O1xuXG4gIC8vIERhdGEgc3RydWN0dXJlcyB0byBzdXBwb3J0IHdhaXRVbnRpbENhdWdodFVwKCkuIEVhY2ggb3Bsb2cgZW50cnkgaGFzIGFcbiAgLy8gTW9uZ29UaW1lc3RhbXAgb2JqZWN0IG9uIGl0ICh3aGljaCBpcyBub3QgdGhlIHNhbWUgYXMgYSBEYXRlIC0tLSBpdCdzIGFcbiAgLy8gY29tYmluYXRpb24gb2YgdGltZSBhbmQgYW4gaW5jcmVtZW50aW5nIGNvdW50ZXI7IHNlZVxuICAvLyBodHRwOi8vZG9jcy5tb25nb2RiLm9yZy9tYW51YWwvcmVmZXJlbmNlL2Jzb24tdHlwZXMvI3RpbWVzdGFtcHMpLlxuICAvL1xuICAvLyBfY2F0Y2hpbmdVcEZ1dHVyZXMgaXMgYW4gYXJyYXkgb2Yge3RzOiBNb25nb1RpbWVzdGFtcCwgZnV0dXJlOiBGdXR1cmV9XG4gIC8vIG9iamVjdHMsIHNvcnRlZCBieSBhc2NlbmRpbmcgdGltZXN0YW1wLiBfbGFzdFByb2Nlc3NlZFRTIGlzIHRoZVxuICAvLyBNb25nb1RpbWVzdGFtcCBvZiB0aGUgbGFzdCBvcGxvZyBlbnRyeSB3ZSd2ZSBwcm9jZXNzZWQuXG4gIC8vXG4gIC8vIEVhY2ggdGltZSB3ZSBjYWxsIHdhaXRVbnRpbENhdWdodFVwLCB3ZSB0YWtlIGEgcGVlayBhdCB0aGUgZmluYWwgb3Bsb2dcbiAgLy8gZW50cnkgaW4gdGhlIGRiLiAgSWYgd2UndmUgYWxyZWFkeSBwcm9jZXNzZWQgaXQgKGllLCBpdCBpcyBub3QgZ3JlYXRlciB0aGFuXG4gIC8vIF9sYXN0UHJvY2Vzc2VkVFMpLCB3YWl0VW50aWxDYXVnaHRVcCBpbW1lZGlhdGVseSByZXR1cm5zLiBPdGhlcndpc2UsXG4gIC8vIHdhaXRVbnRpbENhdWdodFVwIG1ha2VzIGEgbmV3IEZ1dHVyZSBhbmQgaW5zZXJ0cyBpdCBhbG9uZyB3aXRoIHRoZSBmaW5hbFxuICAvLyB0aW1lc3RhbXAgZW50cnkgdGhhdCBpdCByZWFkLCBpbnRvIF9jYXRjaGluZ1VwRnV0dXJlcy4gd2FpdFVudGlsQ2F1Z2h0VXBcbiAgLy8gdGhlbiB3YWl0cyBvbiB0aGF0IGZ1dHVyZSwgd2hpY2ggaXMgcmVzb2x2ZWQgb25jZSBfbGFzdFByb2Nlc3NlZFRTIGlzXG4gIC8vIGluY3JlbWVudGVkIHRvIGJlIHBhc3QgaXRzIHRpbWVzdGFtcCBieSB0aGUgd29ya2VyIGZpYmVyLlxuICAvL1xuICAvLyBYWFggdXNlIGEgcHJpb3JpdHkgcXVldWUgb3Igc29tZXRoaW5nIGVsc2UgdGhhdCdzIGZhc3RlciB0aGFuIGFuIGFycmF5XG4gIHNlbGYuX2NhdGNoaW5nVXBGdXR1cmVzID0gW107XG4gIHNlbGYuX2xhc3RQcm9jZXNzZWRUUyA9IG51bGw7XG5cbiAgc2VsZi5fb25Ta2lwcGVkRW50cmllc0hvb2sgPSBuZXcgSG9vayh7XG4gICAgZGVidWdQcmludEV4Y2VwdGlvbnM6IFwib25Ta2lwcGVkRW50cmllcyBjYWxsYmFja1wiXG4gIH0pO1xuXG4gIHNlbGYuX2VudHJ5UXVldWUgPSBuZXcgTWV0ZW9yLl9Eb3VibGVFbmRlZFF1ZXVlKCk7XG4gIHNlbGYuX3dvcmtlckFjdGl2ZSA9IGZhbHNlO1xuXG4gIHNlbGYuX3N0YXJ0VGFpbGluZygpO1xufTtcblxuXy5leHRlbmQoT3Bsb2dIYW5kbGUucHJvdG90eXBlLCB7XG4gIHN0b3A6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICByZXR1cm47XG4gICAgc2VsZi5fc3RvcHBlZCA9IHRydWU7XG4gICAgaWYgKHNlbGYuX3RhaWxIYW5kbGUpXG4gICAgICBzZWxmLl90YWlsSGFuZGxlLnN0b3AoKTtcbiAgICAvLyBYWFggc2hvdWxkIGNsb3NlIGNvbm5lY3Rpb25zIHRvb1xuICB9LFxuICBvbk9wbG9nRW50cnk6IGZ1bmN0aW9uICh0cmlnZ2VyLCBjYWxsYmFjaykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbGxlZCBvbk9wbG9nRW50cnkgb24gc3RvcHBlZCBoYW5kbGUhXCIpO1xuXG4gICAgLy8gQ2FsbGluZyBvbk9wbG9nRW50cnkgcmVxdWlyZXMgdXMgdG8gd2FpdCBmb3IgdGhlIHRhaWxpbmcgdG8gYmUgcmVhZHkuXG4gICAgc2VsZi5fcmVhZHlGdXR1cmUud2FpdCgpO1xuXG4gICAgdmFyIG9yaWdpbmFsQ2FsbGJhY2sgPSBjYWxsYmFjaztcbiAgICBjYWxsYmFjayA9IE1ldGVvci5iaW5kRW52aXJvbm1lbnQoZnVuY3Rpb24gKG5vdGlmaWNhdGlvbikge1xuICAgICAgb3JpZ2luYWxDYWxsYmFjayhub3RpZmljYXRpb24pO1xuICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgIE1ldGVvci5fZGVidWcoXCJFcnJvciBpbiBvcGxvZyBjYWxsYmFja1wiLCBlcnIpO1xuICAgIH0pO1xuICAgIHZhciBsaXN0ZW5IYW5kbGUgPSBzZWxmLl9jcm9zc2Jhci5saXN0ZW4odHJpZ2dlciwgY2FsbGJhY2spO1xuICAgIHJldHVybiB7XG4gICAgICBzdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGxpc3RlbkhhbmRsZS5zdG9wKCk7XG4gICAgICB9XG4gICAgfTtcbiAgfSxcbiAgLy8gUmVnaXN0ZXIgYSBjYWxsYmFjayB0byBiZSBpbnZva2VkIGFueSB0aW1lIHdlIHNraXAgb3Bsb2cgZW50cmllcyAoZWcsXG4gIC8vIGJlY2F1c2Ugd2UgYXJlIHRvbyBmYXIgYmVoaW5kKS5cbiAgb25Ta2lwcGVkRW50cmllczogZnVuY3Rpb24gKGNhbGxiYWNrKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FsbGVkIG9uU2tpcHBlZEVudHJpZXMgb24gc3RvcHBlZCBoYW5kbGUhXCIpO1xuICAgIHJldHVybiBzZWxmLl9vblNraXBwZWRFbnRyaWVzSG9vay5yZWdpc3RlcihjYWxsYmFjayk7XG4gIH0sXG4gIC8vIENhbGxzIGBjYWxsYmFja2Agb25jZSB0aGUgb3Bsb2cgaGFzIGJlZW4gcHJvY2Vzc2VkIHVwIHRvIGEgcG9pbnQgdGhhdCBpc1xuICAvLyByb3VnaGx5IFwibm93XCI6IHNwZWNpZmljYWxseSwgb25jZSB3ZSd2ZSBwcm9jZXNzZWQgYWxsIG9wcyB0aGF0IGFyZVxuICAvLyBjdXJyZW50bHkgdmlzaWJsZS5cbiAgLy8gWFhYIGJlY29tZSBjb252aW5jZWQgdGhhdCB0aGlzIGlzIGFjdHVhbGx5IHNhZmUgZXZlbiBpZiBvcGxvZ0Nvbm5lY3Rpb25cbiAgLy8gaXMgc29tZSBraW5kIG9mIHBvb2xcbiAgd2FpdFVudGlsQ2F1Z2h0VXA6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYWxsZWQgd2FpdFVudGlsQ2F1Z2h0VXAgb24gc3RvcHBlZCBoYW5kbGUhXCIpO1xuXG4gICAgLy8gQ2FsbGluZyB3YWl0VW50aWxDYXVnaHRVcCByZXF1cmllcyB1cyB0byB3YWl0IGZvciB0aGUgb3Bsb2cgY29ubmVjdGlvbiB0b1xuICAgIC8vIGJlIHJlYWR5LlxuICAgIHNlbGYuX3JlYWR5RnV0dXJlLndhaXQoKTtcbiAgICB2YXIgbGFzdEVudHJ5O1xuXG4gICAgd2hpbGUgKCFzZWxmLl9zdG9wcGVkKSB7XG4gICAgICAvLyBXZSBuZWVkIHRvIG1ha2UgdGhlIHNlbGVjdG9yIGF0IGxlYXN0IGFzIHJlc3RyaWN0aXZlIGFzIHRoZSBhY3R1YWxcbiAgICAgIC8vIHRhaWxpbmcgc2VsZWN0b3IgKGllLCB3ZSBuZWVkIHRvIHNwZWNpZnkgdGhlIERCIG5hbWUpIG9yIGVsc2Ugd2UgbWlnaHRcbiAgICAgIC8vIGZpbmQgYSBUUyB0aGF0IHdvbid0IHNob3cgdXAgaW4gdGhlIGFjdHVhbCB0YWlsIHN0cmVhbS5cbiAgICAgIHRyeSB7XG4gICAgICAgIGxhc3RFbnRyeSA9IHNlbGYuX29wbG9nTGFzdEVudHJ5Q29ubmVjdGlvbi5maW5kT25lKFxuICAgICAgICAgIE9QTE9HX0NPTExFQ1RJT04sIHNlbGYuX2Jhc2VPcGxvZ1NlbGVjdG9yLFxuICAgICAgICAgIHtmaWVsZHM6IHt0czogMX0sIHNvcnQ6IHskbmF0dXJhbDogLTF9fSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyBEdXJpbmcgZmFpbG92ZXIgKGVnKSBpZiB3ZSBnZXQgYW4gZXhjZXB0aW9uIHdlIHNob3VsZCBsb2cgYW5kIHJldHJ5XG4gICAgICAgIC8vIGluc3RlYWQgb2YgY3Jhc2hpbmcuXG4gICAgICAgIE1ldGVvci5fZGVidWcoXCJHb3QgZXhjZXB0aW9uIHdoaWxlIHJlYWRpbmcgbGFzdCBlbnRyeVwiLCBlKTtcbiAgICAgICAgTWV0ZW9yLl9zbGVlcEZvck1zKDEwMCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICByZXR1cm47XG5cbiAgICBpZiAoIWxhc3RFbnRyeSkge1xuICAgICAgLy8gUmVhbGx5LCBub3RoaW5nIGluIHRoZSBvcGxvZz8gV2VsbCwgd2UndmUgcHJvY2Vzc2VkIGV2ZXJ5dGhpbmcuXG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdmFyIHRzID0gbGFzdEVudHJ5LnRzO1xuICAgIGlmICghdHMpXG4gICAgICB0aHJvdyBFcnJvcihcIm9wbG9nIGVudHJ5IHdpdGhvdXQgdHM6IFwiICsgRUpTT04uc3RyaW5naWZ5KGxhc3RFbnRyeSkpO1xuXG4gICAgaWYgKHNlbGYuX2xhc3RQcm9jZXNzZWRUUyAmJiB0cy5sZXNzVGhhbk9yRXF1YWwoc2VsZi5fbGFzdFByb2Nlc3NlZFRTKSkge1xuICAgICAgLy8gV2UndmUgYWxyZWFkeSBjYXVnaHQgdXAgdG8gaGVyZS5cbiAgICAgIHJldHVybjtcbiAgICB9XG5cblxuICAgIC8vIEluc2VydCB0aGUgZnV0dXJlIGludG8gb3VyIGxpc3QuIEFsbW9zdCBhbHdheXMsIHRoaXMgd2lsbCBiZSBhdCB0aGUgZW5kLFxuICAgIC8vIGJ1dCBpdCdzIGNvbmNlaXZhYmxlIHRoYXQgaWYgd2UgZmFpbCBvdmVyIGZyb20gb25lIHByaW1hcnkgdG8gYW5vdGhlcixcbiAgICAvLyB0aGUgb3Bsb2cgZW50cmllcyB3ZSBzZWUgd2lsbCBnbyBiYWNrd2FyZHMuXG4gICAgdmFyIGluc2VydEFmdGVyID0gc2VsZi5fY2F0Y2hpbmdVcEZ1dHVyZXMubGVuZ3RoO1xuICAgIHdoaWxlIChpbnNlcnRBZnRlciAtIDEgPiAwICYmIHNlbGYuX2NhdGNoaW5nVXBGdXR1cmVzW2luc2VydEFmdGVyIC0gMV0udHMuZ3JlYXRlclRoYW4odHMpKSB7XG4gICAgICBpbnNlcnRBZnRlci0tO1xuICAgIH1cbiAgICB2YXIgZiA9IG5ldyBGdXR1cmU7XG4gICAgc2VsZi5fY2F0Y2hpbmdVcEZ1dHVyZXMuc3BsaWNlKGluc2VydEFmdGVyLCAwLCB7dHM6IHRzLCBmdXR1cmU6IGZ9KTtcbiAgICBmLndhaXQoKTtcbiAgfSxcbiAgX3N0YXJ0VGFpbGluZzogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAvLyBGaXJzdCwgbWFrZSBzdXJlIHRoYXQgd2UncmUgdGFsa2luZyB0byB0aGUgbG9jYWwgZGF0YWJhc2UuXG4gICAgdmFyIG1vbmdvZGJVcmkgPSBOcG0ucmVxdWlyZSgnbW9uZ29kYi11cmknKTtcbiAgICBpZiAobW9uZ29kYlVyaS5wYXJzZShzZWxmLl9vcGxvZ1VybCkuZGF0YWJhc2UgIT09ICdsb2NhbCcpIHtcbiAgICAgIHRocm93IEVycm9yKFwiJE1PTkdPX09QTE9HX1VSTCBtdXN0IGJlIHNldCB0byB0aGUgJ2xvY2FsJyBkYXRhYmFzZSBvZiBcIiArXG4gICAgICAgICAgICAgICAgICBcImEgTW9uZ28gcmVwbGljYSBzZXRcIik7XG4gICAgfVxuXG4gICAgLy8gV2UgbWFrZSB0d28gc2VwYXJhdGUgY29ubmVjdGlvbnMgdG8gTW9uZ28uIFRoZSBOb2RlIE1vbmdvIGRyaXZlclxuICAgIC8vIGltcGxlbWVudHMgYSBuYWl2ZSByb3VuZC1yb2JpbiBjb25uZWN0aW9uIHBvb2w6IGVhY2ggXCJjb25uZWN0aW9uXCIgaXMgYVxuICAgIC8vIHBvb2wgb2Ygc2V2ZXJhbCAoNSBieSBkZWZhdWx0KSBUQ1AgY29ubmVjdGlvbnMsIGFuZCBlYWNoIHJlcXVlc3QgaXNcbiAgICAvLyByb3RhdGVkIHRocm91Z2ggdGhlIHBvb2xzLiBUYWlsYWJsZSBjdXJzb3IgcXVlcmllcyBibG9jayBvbiB0aGUgc2VydmVyXG4gICAgLy8gdW50aWwgdGhlcmUgaXMgc29tZSBkYXRhIHRvIHJldHVybiAob3IgdW50aWwgYSBmZXcgc2Vjb25kcyBoYXZlXG4gICAgLy8gcGFzc2VkKS4gU28gaWYgdGhlIGNvbm5lY3Rpb24gcG9vbCB1c2VkIGZvciB0YWlsaW5nIGN1cnNvcnMgaXMgdGhlIHNhbWVcbiAgICAvLyBwb29sIHVzZWQgZm9yIG90aGVyIHF1ZXJpZXMsIHRoZSBvdGhlciBxdWVyaWVzIHdpbGwgYmUgZGVsYXllZCBieSBzZWNvbmRzXG4gICAgLy8gMS81IG9mIHRoZSB0aW1lLlxuICAgIC8vXG4gICAgLy8gVGhlIHRhaWwgY29ubmVjdGlvbiB3aWxsIG9ubHkgZXZlciBiZSBydW5uaW5nIGEgc2luZ2xlIHRhaWwgY29tbWFuZCwgc29cbiAgICAvLyBpdCBvbmx5IG5lZWRzIHRvIG1ha2Ugb25lIHVuZGVybHlpbmcgVENQIGNvbm5lY3Rpb24uXG4gICAgc2VsZi5fb3Bsb2dUYWlsQ29ubmVjdGlvbiA9IG5ldyBNb25nb0Nvbm5lY3Rpb24oXG4gICAgICBzZWxmLl9vcGxvZ1VybCwge3Bvb2xTaXplOiAxfSk7XG4gICAgLy8gWFhYIGJldHRlciBkb2NzLCBidXQ6IGl0J3MgdG8gZ2V0IG1vbm90b25pYyByZXN1bHRzXG4gICAgLy8gWFhYIGlzIGl0IHNhZmUgdG8gc2F5IFwiaWYgdGhlcmUncyBhbiBpbiBmbGlnaHQgcXVlcnksIGp1c3QgdXNlIGl0c1xuICAgIC8vICAgICByZXN1bHRzXCI/IEkgZG9uJ3QgdGhpbmsgc28gYnV0IHNob3VsZCBjb25zaWRlciB0aGF0XG4gICAgc2VsZi5fb3Bsb2dMYXN0RW50cnlDb25uZWN0aW9uID0gbmV3IE1vbmdvQ29ubmVjdGlvbihcbiAgICAgIHNlbGYuX29wbG9nVXJsLCB7cG9vbFNpemU6IDF9KTtcblxuICAgIC8vIE5vdywgbWFrZSBzdXJlIHRoYXQgdGhlcmUgYWN0dWFsbHkgaXMgYSByZXBsIHNldCBoZXJlLiBJZiBub3QsIG9wbG9nXG4gICAgLy8gdGFpbGluZyB3b24ndCBldmVyIGZpbmQgYW55dGhpbmchXG4gICAgLy8gTW9yZSBvbiB0aGUgaXNNYXN0ZXJEb2NcbiAgICAvLyBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9jb21tYW5kL2lzTWFzdGVyL1xuICAgIHZhciBmID0gbmV3IEZ1dHVyZTtcbiAgICBzZWxmLl9vcGxvZ0xhc3RFbnRyeUNvbm5lY3Rpb24uZGIuYWRtaW4oKS5jb21tYW5kKFxuICAgICAgeyBpc21hc3RlcjogMSB9LCBmLnJlc29sdmVyKCkpO1xuICAgIHZhciBpc01hc3RlckRvYyA9IGYud2FpdCgpO1xuXG4gICAgaWYgKCEoaXNNYXN0ZXJEb2MgJiYgaXNNYXN0ZXJEb2Muc2V0TmFtZSkpIHtcbiAgICAgIHRocm93IEVycm9yKFwiJE1PTkdPX09QTE9HX1VSTCBtdXN0IGJlIHNldCB0byB0aGUgJ2xvY2FsJyBkYXRhYmFzZSBvZiBcIiArXG4gICAgICAgICAgICAgICAgICBcImEgTW9uZ28gcmVwbGljYSBzZXRcIik7XG4gICAgfVxuXG4gICAgLy8gRmluZCB0aGUgbGFzdCBvcGxvZyBlbnRyeS5cbiAgICB2YXIgbGFzdE9wbG9nRW50cnkgPSBzZWxmLl9vcGxvZ0xhc3RFbnRyeUNvbm5lY3Rpb24uZmluZE9uZShcbiAgICAgIE9QTE9HX0NPTExFQ1RJT04sIHt9LCB7c29ydDogeyRuYXR1cmFsOiAtMX0sIGZpZWxkczoge3RzOiAxfX0pO1xuXG4gICAgdmFyIG9wbG9nU2VsZWN0b3IgPSBfLmNsb25lKHNlbGYuX2Jhc2VPcGxvZ1NlbGVjdG9yKTtcbiAgICBpZiAobGFzdE9wbG9nRW50cnkpIHtcbiAgICAgIC8vIFN0YXJ0IGFmdGVyIHRoZSBsYXN0IGVudHJ5IHRoYXQgY3VycmVudGx5IGV4aXN0cy5cbiAgICAgIG9wbG9nU2VsZWN0b3IudHMgPSB7JGd0OiBsYXN0T3Bsb2dFbnRyeS50c307XG4gICAgICAvLyBJZiB0aGVyZSBhcmUgYW55IGNhbGxzIHRvIGNhbGxXaGVuUHJvY2Vzc2VkTGF0ZXN0IGJlZm9yZSBhbnkgb3RoZXJcbiAgICAgIC8vIG9wbG9nIGVudHJpZXMgc2hvdyB1cCwgYWxsb3cgY2FsbFdoZW5Qcm9jZXNzZWRMYXRlc3QgdG8gY2FsbCBpdHNcbiAgICAgIC8vIGNhbGxiYWNrIGltbWVkaWF0ZWx5LlxuICAgICAgc2VsZi5fbGFzdFByb2Nlc3NlZFRTID0gbGFzdE9wbG9nRW50cnkudHM7XG4gICAgfVxuXG4gICAgdmFyIGN1cnNvckRlc2NyaXB0aW9uID0gbmV3IEN1cnNvckRlc2NyaXB0aW9uKFxuICAgICAgT1BMT0dfQ09MTEVDVElPTiwgb3Bsb2dTZWxlY3Rvciwge3RhaWxhYmxlOiB0cnVlfSk7XG5cbiAgICAvLyBTdGFydCB0YWlsaW5nIHRoZSBvcGxvZy5cbiAgICAvL1xuICAgIC8vIFdlIHJlc3RhcnQgdGhlIGxvdy1sZXZlbCBvcGxvZyBxdWVyeSBldmVyeSAzMCBzZWNvbmRzIGlmIHdlIGRpZG4ndCBnZXQgYVxuICAgIC8vIGRvYy4gVGhpcyBpcyBhIHdvcmthcm91bmQgZm9yICM4NTk4OiB0aGUgTm9kZSBNb25nbyBkcml2ZXIgaGFzIGF0IGxlYXN0XG4gICAgLy8gb25lIGJ1ZyB0aGF0IGNhbiBsZWFkIHRvIHF1ZXJ5IGNhbGxiYWNrcyBuZXZlciBnZXR0aW5nIGNhbGxlZCAoZXZlbiB3aXRoXG4gICAgLy8gYW4gZXJyb3IpIHdoZW4gbGVhZGVyc2hpcCBmYWlsb3ZlciBvY2N1ci5cbiAgICBzZWxmLl90YWlsSGFuZGxlID0gc2VsZi5fb3Bsb2dUYWlsQ29ubmVjdGlvbi50YWlsKFxuICAgICAgY3Vyc29yRGVzY3JpcHRpb24sXG4gICAgICBmdW5jdGlvbiAoZG9jKSB7XG4gICAgICAgIHNlbGYuX2VudHJ5UXVldWUucHVzaChkb2MpO1xuICAgICAgICBzZWxmLl9tYXliZVN0YXJ0V29ya2VyKCk7XG4gICAgICB9LFxuICAgICAgVEFJTF9USU1FT1VUXG4gICAgKTtcbiAgICBzZWxmLl9yZWFkeUZ1dHVyZS5yZXR1cm4oKTtcbiAgfSxcblxuICBfbWF5YmVTdGFydFdvcmtlcjogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5fd29ya2VyQWN0aXZlKSByZXR1cm47XG4gICAgc2VsZi5fd29ya2VyQWN0aXZlID0gdHJ1ZTtcblxuICAgIE1ldGVvci5kZWZlcihmdW5jdGlvbiAoKSB7XG4gICAgICAvLyBNYXkgYmUgY2FsbGVkIHJlY3Vyc2l2ZWx5IGluIGNhc2Ugb2YgdHJhbnNhY3Rpb25zLlxuICAgICAgZnVuY3Rpb24gaGFuZGxlRG9jKGRvYykge1xuICAgICAgICBpZiAoZG9jLm5zID09PSBcImFkbWluLiRjbWRcIikge1xuICAgICAgICAgIGlmIChkb2Muby5hcHBseU9wcykge1xuICAgICAgICAgICAgLy8gVGhpcyB3YXMgYSBzdWNjZXNzZnVsIHRyYW5zYWN0aW9uLCBzbyB3ZSBuZWVkIHRvIGFwcGx5IHRoZVxuICAgICAgICAgICAgLy8gb3BlcmF0aW9ucyB0aGF0IHdlcmUgaW52b2x2ZWQuXG4gICAgICAgICAgICBsZXQgbmV4dFRpbWVzdGFtcCA9IGRvYy50cztcbiAgICAgICAgICAgIGRvYy5vLmFwcGx5T3BzLmZvckVhY2gob3AgPT4ge1xuICAgICAgICAgICAgICAvLyBTZWUgaHR0cHM6Ly9naXRodWIuY29tL21ldGVvci9tZXRlb3IvaXNzdWVzLzEwNDIwLlxuICAgICAgICAgICAgICBpZiAoIW9wLnRzKSB7XG4gICAgICAgICAgICAgICAgb3AudHMgPSBuZXh0VGltZXN0YW1wO1xuICAgICAgICAgICAgICAgIG5leHRUaW1lc3RhbXAgPSBuZXh0VGltZXN0YW1wLmFkZChUaW1lc3RhbXAuT05FKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBoYW5kbGVEb2Mob3ApO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlVua25vd24gY29tbWFuZCBcIiArIEVKU09OLnN0cmluZ2lmeShkb2MpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRyaWdnZXIgPSB7XG4gICAgICAgICAgZHJvcENvbGxlY3Rpb246IGZhbHNlLFxuICAgICAgICAgIGRyb3BEYXRhYmFzZTogZmFsc2UsXG4gICAgICAgICAgb3A6IGRvYyxcbiAgICAgICAgfTtcblxuICAgICAgICBpZiAodHlwZW9mIGRvYy5ucyA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICAgICAgZG9jLm5zLnN0YXJ0c1dpdGgoc2VsZi5fZGJOYW1lICsgXCIuXCIpKSB7XG4gICAgICAgICAgdHJpZ2dlci5jb2xsZWN0aW9uID0gZG9jLm5zLnNsaWNlKHNlbGYuX2RiTmFtZS5sZW5ndGggKyAxKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIElzIGl0IGEgc3BlY2lhbCBjb21tYW5kIGFuZCB0aGUgY29sbGVjdGlvbiBuYW1lIGlzIGhpZGRlblxuICAgICAgICAvLyBzb21ld2hlcmUgaW4gb3BlcmF0b3I/XG4gICAgICAgIGlmICh0cmlnZ2VyLmNvbGxlY3Rpb24gPT09IFwiJGNtZFwiKSB7XG4gICAgICAgICAgaWYgKGRvYy5vLmRyb3BEYXRhYmFzZSkge1xuICAgICAgICAgICAgZGVsZXRlIHRyaWdnZXIuY29sbGVjdGlvbjtcbiAgICAgICAgICAgIHRyaWdnZXIuZHJvcERhdGFiYXNlID0gdHJ1ZTtcbiAgICAgICAgICB9IGVsc2UgaWYgKF8uaGFzKGRvYy5vLCBcImRyb3BcIikpIHtcbiAgICAgICAgICAgIHRyaWdnZXIuY29sbGVjdGlvbiA9IGRvYy5vLmRyb3A7XG4gICAgICAgICAgICB0cmlnZ2VyLmRyb3BDb2xsZWN0aW9uID0gdHJ1ZTtcbiAgICAgICAgICAgIHRyaWdnZXIuaWQgPSBudWxsO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBFcnJvcihcIlVua25vd24gY29tbWFuZCBcIiArIEVKU09OLnN0cmluZ2lmeShkb2MpKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBBbGwgb3RoZXIgb3BzIGhhdmUgYW4gaWQuXG4gICAgICAgICAgdHJpZ2dlci5pZCA9IGlkRm9yT3AoZG9jKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNlbGYuX2Nyb3NzYmFyLmZpcmUodHJpZ2dlcik7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIHdoaWxlICghIHNlbGYuX3N0b3BwZWQgJiZcbiAgICAgICAgICAgICAgICEgc2VsZi5fZW50cnlRdWV1ZS5pc0VtcHR5KCkpIHtcbiAgICAgICAgICAvLyBBcmUgd2UgdG9vIGZhciBiZWhpbmQ/IEp1c3QgdGVsbCBvdXIgb2JzZXJ2ZXJzIHRoYXQgdGhleSBuZWVkIHRvXG4gICAgICAgICAgLy8gcmVwb2xsLCBhbmQgZHJvcCBvdXIgcXVldWUuXG4gICAgICAgICAgaWYgKHNlbGYuX2VudHJ5UXVldWUubGVuZ3RoID4gVE9PX0ZBUl9CRUhJTkQpIHtcbiAgICAgICAgICAgIHZhciBsYXN0RW50cnkgPSBzZWxmLl9lbnRyeVF1ZXVlLnBvcCgpO1xuICAgICAgICAgICAgc2VsZi5fZW50cnlRdWV1ZS5jbGVhcigpO1xuXG4gICAgICAgICAgICBzZWxmLl9vblNraXBwZWRFbnRyaWVzSG9vay5lYWNoKGZ1bmN0aW9uIChjYWxsYmFjaykge1xuICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBGcmVlIGFueSB3YWl0VW50aWxDYXVnaHRVcCgpIGNhbGxzIHRoYXQgd2VyZSB3YWl0aW5nIGZvciB1cyB0b1xuICAgICAgICAgICAgLy8gcGFzcyBzb21ldGhpbmcgdGhhdCB3ZSBqdXN0IHNraXBwZWQuXG4gICAgICAgICAgICBzZWxmLl9zZXRMYXN0UHJvY2Vzc2VkVFMobGFzdEVudHJ5LnRzKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IGRvYyA9IHNlbGYuX2VudHJ5UXVldWUuc2hpZnQoKTtcblxuICAgICAgICAgIC8vIEZpcmUgdHJpZ2dlcihzKSBmb3IgdGhpcyBkb2MuXG4gICAgICAgICAgaGFuZGxlRG9jKGRvYyk7XG5cbiAgICAgICAgICAvLyBOb3cgdGhhdCB3ZSd2ZSBwcm9jZXNzZWQgdGhpcyBvcGVyYXRpb24sIHByb2Nlc3MgcGVuZGluZ1xuICAgICAgICAgIC8vIHNlcXVlbmNlcnMuXG4gICAgICAgICAgaWYgKGRvYy50cykge1xuICAgICAgICAgICAgc2VsZi5fc2V0TGFzdFByb2Nlc3NlZFRTKGRvYy50cyk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IEVycm9yKFwib3Bsb2cgZW50cnkgd2l0aG91dCB0czogXCIgKyBFSlNPTi5zdHJpbmdpZnkoZG9jKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBzZWxmLl93b3JrZXJBY3RpdmUgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcblxuICBfc2V0TGFzdFByb2Nlc3NlZFRTOiBmdW5jdGlvbiAodHMpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgc2VsZi5fbGFzdFByb2Nlc3NlZFRTID0gdHM7XG4gICAgd2hpbGUgKCFfLmlzRW1wdHkoc2VsZi5fY2F0Y2hpbmdVcEZ1dHVyZXMpICYmIHNlbGYuX2NhdGNoaW5nVXBGdXR1cmVzWzBdLnRzLmxlc3NUaGFuT3JFcXVhbChzZWxmLl9sYXN0UHJvY2Vzc2VkVFMpKSB7XG4gICAgICB2YXIgc2VxdWVuY2VyID0gc2VsZi5fY2F0Y2hpbmdVcEZ1dHVyZXMuc2hpZnQoKTtcbiAgICAgIHNlcXVlbmNlci5mdXR1cmUucmV0dXJuKCk7XG4gICAgfVxuICB9LFxuXG4gIC8vTWV0aG9kcyB1c2VkIG9uIHRlc3RzIHRvIGRpbmFtaWNhbGx5IGNoYW5nZSBUT09fRkFSX0JFSElORFxuICBfZGVmaW5lVG9vRmFyQmVoaW5kOiBmdW5jdGlvbih2YWx1ZSkge1xuICAgIFRPT19GQVJfQkVISU5EID0gdmFsdWU7XG4gIH0sXG4gIF9yZXNldFRvb0ZhckJlaGluZDogZnVuY3Rpb24oKSB7XG4gICAgVE9PX0ZBUl9CRUhJTkQgPSBwcm9jZXNzLmVudi5NRVRFT1JfT1BMT0dfVE9PX0ZBUl9CRUhJTkQgfHwgMjAwMDtcbiAgfVxufSk7XG4iLCJ2YXIgRnV0dXJlID0gTnBtLnJlcXVpcmUoJ2ZpYmVycy9mdXR1cmUnKTtcblxuT2JzZXJ2ZU11bHRpcGxleGVyID0gZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIGlmICghb3B0aW9ucyB8fCAhXy5oYXMob3B0aW9ucywgJ29yZGVyZWQnKSlcbiAgICB0aHJvdyBFcnJvcihcIm11c3Qgc3BlY2lmaWVkIG9yZGVyZWRcIik7XG5cbiAgUGFja2FnZVsnZmFjdHMtYmFzZSddICYmIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXS5GYWN0cy5pbmNyZW1lbnRTZXJ2ZXJGYWN0KFxuICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLW11bHRpcGxleGVyc1wiLCAxKTtcblxuICBzZWxmLl9vcmRlcmVkID0gb3B0aW9ucy5vcmRlcmVkO1xuICBzZWxmLl9vblN0b3AgPSBvcHRpb25zLm9uU3RvcCB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgc2VsZi5fcXVldWUgPSBuZXcgTWV0ZW9yLl9TeW5jaHJvbm91c1F1ZXVlKCk7XG4gIHNlbGYuX2hhbmRsZXMgPSB7fTtcbiAgc2VsZi5fcmVhZHlGdXR1cmUgPSBuZXcgRnV0dXJlO1xuICBzZWxmLl9jYWNoZSA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0NhY2hpbmdDaGFuZ2VPYnNlcnZlcih7XG4gICAgb3JkZXJlZDogb3B0aW9ucy5vcmRlcmVkfSk7XG4gIC8vIE51bWJlciBvZiBhZGRIYW5kbGVBbmRTZW5kSW5pdGlhbEFkZHMgdGFza3Mgc2NoZWR1bGVkIGJ1dCBub3QgeWV0XG4gIC8vIHJ1bm5pbmcuIHJlbW92ZUhhbmRsZSB1c2VzIHRoaXMgdG8ga25vdyBpZiBpdCdzIHRpbWUgdG8gY2FsbCB0aGUgb25TdG9wXG4gIC8vIGNhbGxiYWNrLlxuICBzZWxmLl9hZGRIYW5kbGVUYXNrc1NjaGVkdWxlZEJ1dE5vdFBlcmZvcm1lZCA9IDA7XG5cbiAgXy5lYWNoKHNlbGYuY2FsbGJhY2tOYW1lcygpLCBmdW5jdGlvbiAoY2FsbGJhY2tOYW1lKSB7XG4gICAgc2VsZltjYWxsYmFja05hbWVdID0gZnVuY3Rpb24gKC8qIC4uLiAqLykge1xuICAgICAgc2VsZi5fYXBwbHlDYWxsYmFjayhjYWxsYmFja05hbWUsIF8udG9BcnJheShhcmd1bWVudHMpKTtcbiAgICB9O1xuICB9KTtcbn07XG5cbl8uZXh0ZW5kKE9ic2VydmVNdWx0aXBsZXhlci5wcm90b3R5cGUsIHtcbiAgYWRkSGFuZGxlQW5kU2VuZEluaXRpYWxBZGRzOiBmdW5jdGlvbiAoaGFuZGxlKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgLy8gQ2hlY2sgdGhpcyBiZWZvcmUgY2FsbGluZyBydW5UYXNrIChldmVuIHRob3VnaCBydW5UYXNrIGRvZXMgdGhlIHNhbWVcbiAgICAvLyBjaGVjaykgc28gdGhhdCB3ZSBkb24ndCBsZWFrIGFuIE9ic2VydmVNdWx0aXBsZXhlciBvbiBlcnJvciBieVxuICAgIC8vIGluY3JlbWVudGluZyBfYWRkSGFuZGxlVGFza3NTY2hlZHVsZWRCdXROb3RQZXJmb3JtZWQgYW5kIG5ldmVyXG4gICAgLy8gZGVjcmVtZW50aW5nIGl0LlxuICAgIGlmICghc2VsZi5fcXVldWUuc2FmZVRvUnVuVGFzaygpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuJ3QgY2FsbCBvYnNlcnZlQ2hhbmdlcyBmcm9tIGFuIG9ic2VydmUgY2FsbGJhY2sgb24gdGhlIHNhbWUgcXVlcnlcIik7XG4gICAgKytzZWxmLl9hZGRIYW5kbGVUYXNrc1NjaGVkdWxlZEJ1dE5vdFBlcmZvcm1lZDtcblxuICAgIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSAmJiBQYWNrYWdlWydmYWN0cy1iYXNlJ10uRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLWhhbmRsZXNcIiwgMSk7XG5cbiAgICBzZWxmLl9xdWV1ZS5ydW5UYXNrKGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX2hhbmRsZXNbaGFuZGxlLl9pZF0gPSBoYW5kbGU7XG4gICAgICAvLyBTZW5kIG91dCB3aGF0ZXZlciBhZGRzIHdlIGhhdmUgc28gZmFyICh3aGV0aGVyIG9yIG5vdCB3ZSB0aGVcbiAgICAgIC8vIG11bHRpcGxleGVyIGlzIHJlYWR5KS5cbiAgICAgIHNlbGYuX3NlbmRBZGRzKGhhbmRsZSk7XG4gICAgICAtLXNlbGYuX2FkZEhhbmRsZVRhc2tzU2NoZWR1bGVkQnV0Tm90UGVyZm9ybWVkO1xuICAgIH0pO1xuICAgIC8vICpvdXRzaWRlKiB0aGUgdGFzaywgc2luY2Ugb3RoZXJ3aXNlIHdlJ2QgZGVhZGxvY2tcbiAgICBzZWxmLl9yZWFkeUZ1dHVyZS53YWl0KCk7XG4gIH0sXG5cbiAgLy8gUmVtb3ZlIGFuIG9ic2VydmUgaGFuZGxlLiBJZiBpdCB3YXMgdGhlIGxhc3Qgb2JzZXJ2ZSBoYW5kbGUsIGNhbGwgdGhlXG4gIC8vIG9uU3RvcCBjYWxsYmFjazsgeW91IGNhbm5vdCBhZGQgYW55IG1vcmUgb2JzZXJ2ZSBoYW5kbGVzIGFmdGVyIHRoaXMuXG4gIC8vXG4gIC8vIFRoaXMgaXMgbm90IHN5bmNocm9uaXplZCB3aXRoIHBvbGxzIGFuZCBoYW5kbGUgYWRkaXRpb25zOiB0aGlzIG1lYW5zIHRoYXRcbiAgLy8geW91IGNhbiBzYWZlbHkgY2FsbCBpdCBmcm9tIHdpdGhpbiBhbiBvYnNlcnZlIGNhbGxiYWNrLCBidXQgaXQgYWxzbyBtZWFuc1xuICAvLyB0aGF0IHdlIGhhdmUgdG8gYmUgY2FyZWZ1bCB3aGVuIHdlIGl0ZXJhdGUgb3ZlciBfaGFuZGxlcy5cbiAgcmVtb3ZlSGFuZGxlOiBmdW5jdGlvbiAoaWQpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICAvLyBUaGlzIHNob3VsZCBub3QgYmUgcG9zc2libGU6IHlvdSBjYW4gb25seSBjYWxsIHJlbW92ZUhhbmRsZSBieSBoYXZpbmdcbiAgICAvLyBhY2Nlc3MgdG8gdGhlIE9ic2VydmVIYW5kbGUsIHdoaWNoIGlzbid0IHJldHVybmVkIHRvIHVzZXIgY29kZSB1bnRpbCB0aGVcbiAgICAvLyBtdWx0aXBsZXggaXMgcmVhZHkuXG4gICAgaWYgKCFzZWxmLl9yZWFkeSgpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuJ3QgcmVtb3ZlIGhhbmRsZXMgdW50aWwgdGhlIG11bHRpcGxleCBpcyByZWFkeVwiKTtcblxuICAgIGRlbGV0ZSBzZWxmLl9oYW5kbGVzW2lkXTtcblxuICAgIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSAmJiBQYWNrYWdlWydmYWN0cy1iYXNlJ10uRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLWhhbmRsZXNcIiwgLTEpO1xuXG4gICAgaWYgKF8uaXNFbXB0eShzZWxmLl9oYW5kbGVzKSAmJlxuICAgICAgICBzZWxmLl9hZGRIYW5kbGVUYXNrc1NjaGVkdWxlZEJ1dE5vdFBlcmZvcm1lZCA9PT0gMCkge1xuICAgICAgc2VsZi5fc3RvcCgpO1xuICAgIH1cbiAgfSxcbiAgX3N0b3A6IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgLy8gSXQgc2hvdWxkbid0IGJlIHBvc3NpYmxlIGZvciB1cyB0byBzdG9wIHdoZW4gYWxsIG91ciBoYW5kbGVzIHN0aWxsXG4gICAgLy8gaGF2ZW4ndCBiZWVuIHJldHVybmVkIGZyb20gb2JzZXJ2ZUNoYW5nZXMhXG4gICAgaWYgKCEgc2VsZi5fcmVhZHkoKSAmJiAhIG9wdGlvbnMuZnJvbVF1ZXJ5RXJyb3IpXG4gICAgICB0aHJvdyBFcnJvcihcInN1cnByaXNpbmcgX3N0b3A6IG5vdCByZWFkeVwiKTtcblxuICAgIC8vIENhbGwgc3RvcCBjYWxsYmFjayAod2hpY2gga2lsbHMgdGhlIHVuZGVybHlpbmcgcHJvY2VzcyB3aGljaCBzZW5kcyB1c1xuICAgIC8vIGNhbGxiYWNrcyBhbmQgcmVtb3ZlcyB1cyBmcm9tIHRoZSBjb25uZWN0aW9uJ3MgZGljdGlvbmFyeSkuXG4gICAgc2VsZi5fb25TdG9wKCk7XG4gICAgUGFja2FnZVsnZmFjdHMtYmFzZSddICYmIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXS5GYWN0cy5pbmNyZW1lbnRTZXJ2ZXJGYWN0KFxuICAgICAgXCJtb25nby1saXZlZGF0YVwiLCBcIm9ic2VydmUtbXVsdGlwbGV4ZXJzXCIsIC0xKTtcblxuICAgIC8vIENhdXNlIGZ1dHVyZSBhZGRIYW5kbGVBbmRTZW5kSW5pdGlhbEFkZHMgY2FsbHMgdG8gdGhyb3cgKGJ1dCB0aGUgb25TdG9wXG4gICAgLy8gY2FsbGJhY2sgc2hvdWxkIG1ha2Ugb3VyIGNvbm5lY3Rpb24gZm9yZ2V0IGFib3V0IHVzKS5cbiAgICBzZWxmLl9oYW5kbGVzID0gbnVsbDtcbiAgfSxcblxuICAvLyBBbGxvd3MgYWxsIGFkZEhhbmRsZUFuZFNlbmRJbml0aWFsQWRkcyBjYWxscyB0byByZXR1cm4sIG9uY2UgYWxsIHByZWNlZGluZ1xuICAvLyBhZGRzIGhhdmUgYmVlbiBwcm9jZXNzZWQuIERvZXMgbm90IGJsb2NrLlxuICByZWFkeTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBzZWxmLl9xdWV1ZS5xdWV1ZVRhc2soZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHNlbGYuX3JlYWR5KCkpXG4gICAgICAgIHRocm93IEVycm9yKFwiY2FuJ3QgbWFrZSBPYnNlcnZlTXVsdGlwbGV4IHJlYWR5IHR3aWNlIVwiKTtcbiAgICAgIHNlbGYuX3JlYWR5RnV0dXJlLnJldHVybigpO1xuICAgIH0pO1xuICB9LFxuXG4gIC8vIElmIHRyeWluZyB0byBleGVjdXRlIHRoZSBxdWVyeSByZXN1bHRzIGluIGFuIGVycm9yLCBjYWxsIHRoaXMuIFRoaXMgaXNcbiAgLy8gaW50ZW5kZWQgZm9yIHBlcm1hbmVudCBlcnJvcnMsIG5vdCB0cmFuc2llbnQgbmV0d29yayBlcnJvcnMgdGhhdCBjb3VsZCBiZVxuICAvLyBmaXhlZC4gSXQgc2hvdWxkIG9ubHkgYmUgY2FsbGVkIGJlZm9yZSByZWFkeSgpLCBiZWNhdXNlIGlmIHlvdSBjYWxsZWQgcmVhZHlcbiAgLy8gdGhhdCBtZWFudCB0aGF0IHlvdSBtYW5hZ2VkIHRvIHJ1biB0aGUgcXVlcnkgb25jZS4gSXQgd2lsbCBzdG9wIHRoaXNcbiAgLy8gT2JzZXJ2ZU11bHRpcGxleCBhbmQgY2F1c2UgYWRkSGFuZGxlQW5kU2VuZEluaXRpYWxBZGRzIGNhbGxzIChhbmQgdGh1c1xuICAvLyBvYnNlcnZlQ2hhbmdlcyBjYWxscykgdG8gdGhyb3cgdGhlIGVycm9yLlxuICBxdWVyeUVycm9yOiBmdW5jdGlvbiAoZXJyKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHNlbGYuX3F1ZXVlLnJ1blRhc2soZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHNlbGYuX3JlYWR5KCkpXG4gICAgICAgIHRocm93IEVycm9yKFwiY2FuJ3QgY2xhaW0gcXVlcnkgaGFzIGFuIGVycm9yIGFmdGVyIGl0IHdvcmtlZCFcIik7XG4gICAgICBzZWxmLl9zdG9wKHtmcm9tUXVlcnlFcnJvcjogdHJ1ZX0pO1xuICAgICAgc2VsZi5fcmVhZHlGdXR1cmUudGhyb3coZXJyKTtcbiAgICB9KTtcbiAgfSxcblxuICAvLyBDYWxscyBcImNiXCIgb25jZSB0aGUgZWZmZWN0cyBvZiBhbGwgXCJyZWFkeVwiLCBcImFkZEhhbmRsZUFuZFNlbmRJbml0aWFsQWRkc1wiXG4gIC8vIGFuZCBvYnNlcnZlIGNhbGxiYWNrcyB3aGljaCBjYW1lIGJlZm9yZSB0aGlzIGNhbGwgaGF2ZSBiZWVuIHByb3BhZ2F0ZWQgdG9cbiAgLy8gYWxsIGhhbmRsZXMuIFwicmVhZHlcIiBtdXN0IGhhdmUgYWxyZWFkeSBiZWVuIGNhbGxlZCBvbiB0aGlzIG11bHRpcGxleGVyLlxuICBvbkZsdXNoOiBmdW5jdGlvbiAoY2IpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgc2VsZi5fcXVldWUucXVldWVUYXNrKGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmICghc2VsZi5fcmVhZHkoKSlcbiAgICAgICAgdGhyb3cgRXJyb3IoXCJvbmx5IGNhbGwgb25GbHVzaCBvbiBhIG11bHRpcGxleGVyIHRoYXQgd2lsbCBiZSByZWFkeVwiKTtcbiAgICAgIGNiKCk7XG4gICAgfSk7XG4gIH0sXG4gIGNhbGxiYWNrTmFtZXM6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuX29yZGVyZWQpXG4gICAgICByZXR1cm4gW1wiYWRkZWRCZWZvcmVcIiwgXCJjaGFuZ2VkXCIsIFwibW92ZWRCZWZvcmVcIiwgXCJyZW1vdmVkXCJdO1xuICAgIGVsc2VcbiAgICAgIHJldHVybiBbXCJhZGRlZFwiLCBcImNoYW5nZWRcIiwgXCJyZW1vdmVkXCJdO1xuICB9LFxuICBfcmVhZHk6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5fcmVhZHlGdXR1cmUuaXNSZXNvbHZlZCgpO1xuICB9LFxuICBfYXBwbHlDYWxsYmFjazogZnVuY3Rpb24gKGNhbGxiYWNrTmFtZSwgYXJncykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBzZWxmLl9xdWV1ZS5xdWV1ZVRhc2soZnVuY3Rpb24gKCkge1xuICAgICAgLy8gSWYgd2Ugc3RvcHBlZCBpbiB0aGUgbWVhbnRpbWUsIGRvIG5vdGhpbmcuXG4gICAgICBpZiAoIXNlbGYuX2hhbmRsZXMpXG4gICAgICAgIHJldHVybjtcblxuICAgICAgLy8gRmlyc3QsIGFwcGx5IHRoZSBjaGFuZ2UgdG8gdGhlIGNhY2hlLlxuICAgICAgLy8gWFhYIFdlIGNvdWxkIG1ha2UgYXBwbHlDaGFuZ2UgY2FsbGJhY2tzIHByb21pc2Ugbm90IHRvIGhhbmcgb24gdG8gYW55XG4gICAgICAvLyBzdGF0ZSBmcm9tIHRoZWlyIGFyZ3VtZW50cyAoYXNzdW1pbmcgdGhhdCB0aGVpciBzdXBwbGllZCBjYWxsYmFja3NcbiAgICAgIC8vIGRvbid0KSBhbmQgc2tpcCB0aGlzIGNsb25lLiBDdXJyZW50bHkgJ2NoYW5nZWQnIGhhbmdzIG9uIHRvIHN0YXRlXG4gICAgICAvLyB0aG91Z2guXG4gICAgICBzZWxmLl9jYWNoZS5hcHBseUNoYW5nZVtjYWxsYmFja05hbWVdLmFwcGx5KG51bGwsIEVKU09OLmNsb25lKGFyZ3MpKTtcblxuICAgICAgLy8gSWYgd2UgaGF2ZW4ndCBmaW5pc2hlZCB0aGUgaW5pdGlhbCBhZGRzLCB0aGVuIHdlIHNob3VsZCBvbmx5IGJlIGdldHRpbmdcbiAgICAgIC8vIGFkZHMuXG4gICAgICBpZiAoIXNlbGYuX3JlYWR5KCkgJiZcbiAgICAgICAgICAoY2FsbGJhY2tOYW1lICE9PSAnYWRkZWQnICYmIGNhbGxiYWNrTmFtZSAhPT0gJ2FkZGVkQmVmb3JlJykpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiR290IFwiICsgY2FsbGJhY2tOYW1lICsgXCIgZHVyaW5nIGluaXRpYWwgYWRkc1wiKTtcbiAgICAgIH1cblxuICAgICAgLy8gTm93IG11bHRpcGxleCB0aGUgY2FsbGJhY2tzIG91dCB0byBhbGwgb2JzZXJ2ZSBoYW5kbGVzLiBJdCdzIE9LIGlmXG4gICAgICAvLyB0aGVzZSBjYWxscyB5aWVsZDsgc2luY2Ugd2UncmUgaW5zaWRlIGEgdGFzaywgbm8gb3RoZXIgdXNlIG9mIG91ciBxdWV1ZVxuICAgICAgLy8gY2FuIGNvbnRpbnVlIHVudGlsIHRoZXNlIGFyZSBkb25lLiAoQnV0IHdlIGRvIGhhdmUgdG8gYmUgY2FyZWZ1bCB0byBub3RcbiAgICAgIC8vIHVzZSBhIGhhbmRsZSB0aGF0IGdvdCByZW1vdmVkLCBiZWNhdXNlIHJlbW92ZUhhbmRsZSBkb2VzIG5vdCB1c2UgdGhlXG4gICAgICAvLyBxdWV1ZTsgdGh1cywgd2UgaXRlcmF0ZSBvdmVyIGFuIGFycmF5IG9mIGtleXMgdGhhdCB3ZSBjb250cm9sLilcbiAgICAgIF8uZWFjaChfLmtleXMoc2VsZi5faGFuZGxlcyksIGZ1bmN0aW9uIChoYW5kbGVJZCkge1xuICAgICAgICB2YXIgaGFuZGxlID0gc2VsZi5faGFuZGxlcyAmJiBzZWxmLl9oYW5kbGVzW2hhbmRsZUlkXTtcbiAgICAgICAgaWYgKCFoYW5kbGUpXG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB2YXIgY2FsbGJhY2sgPSBoYW5kbGVbJ18nICsgY2FsbGJhY2tOYW1lXTtcbiAgICAgICAgLy8gY2xvbmUgYXJndW1lbnRzIHNvIHRoYXQgY2FsbGJhY2tzIGNhbiBtdXRhdGUgdGhlaXIgYXJndW1lbnRzXG4gICAgICAgIGNhbGxiYWNrICYmIGNhbGxiYWNrLmFwcGx5KG51bGwsIEVKU09OLmNsb25lKGFyZ3MpKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9LFxuXG4gIC8vIFNlbmRzIGluaXRpYWwgYWRkcyB0byBhIGhhbmRsZS4gSXQgc2hvdWxkIG9ubHkgYmUgY2FsbGVkIGZyb20gd2l0aGluIGEgdGFza1xuICAvLyAodGhlIHRhc2sgdGhhdCBpcyBwcm9jZXNzaW5nIHRoZSBhZGRIYW5kbGVBbmRTZW5kSW5pdGlhbEFkZHMgY2FsbCkuIEl0XG4gIC8vIHN5bmNocm9ub3VzbHkgaW52b2tlcyB0aGUgaGFuZGxlJ3MgYWRkZWQgb3IgYWRkZWRCZWZvcmU7IHRoZXJlJ3Mgbm8gbmVlZCB0b1xuICAvLyBmbHVzaCB0aGUgcXVldWUgYWZ0ZXJ3YXJkcyB0byBlbnN1cmUgdGhhdCB0aGUgY2FsbGJhY2tzIGdldCBvdXQuXG4gIF9zZW5kQWRkczogZnVuY3Rpb24gKGhhbmRsZSkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5fcXVldWUuc2FmZVRvUnVuVGFzaygpKVxuICAgICAgdGhyb3cgRXJyb3IoXCJfc2VuZEFkZHMgbWF5IG9ubHkgYmUgY2FsbGVkIGZyb20gd2l0aGluIGEgdGFzayFcIik7XG4gICAgdmFyIGFkZCA9IHNlbGYuX29yZGVyZWQgPyBoYW5kbGUuX2FkZGVkQmVmb3JlIDogaGFuZGxlLl9hZGRlZDtcbiAgICBpZiAoIWFkZClcbiAgICAgIHJldHVybjtcbiAgICAvLyBub3RlOiBkb2NzIG1heSBiZSBhbiBfSWRNYXAgb3IgYW4gT3JkZXJlZERpY3RcbiAgICBzZWxmLl9jYWNoZS5kb2NzLmZvckVhY2goZnVuY3Rpb24gKGRvYywgaWQpIHtcbiAgICAgIGlmICghXy5oYXMoc2VsZi5faGFuZGxlcywgaGFuZGxlLl9pZCkpXG4gICAgICAgIHRocm93IEVycm9yKFwiaGFuZGxlIGdvdCByZW1vdmVkIGJlZm9yZSBzZW5kaW5nIGluaXRpYWwgYWRkcyFcIik7XG4gICAgICB2YXIgZmllbGRzID0gRUpTT04uY2xvbmUoZG9jKTtcbiAgICAgIGRlbGV0ZSBmaWVsZHMuX2lkO1xuICAgICAgaWYgKHNlbGYuX29yZGVyZWQpXG4gICAgICAgIGFkZChpZCwgZmllbGRzLCBudWxsKTsgLy8gd2UncmUgZ29pbmcgaW4gb3JkZXIsIHNvIGFkZCBhdCBlbmRcbiAgICAgIGVsc2VcbiAgICAgICAgYWRkKGlkLCBmaWVsZHMpO1xuICAgIH0pO1xuICB9XG59KTtcblxuXG52YXIgbmV4dE9ic2VydmVIYW5kbGVJZCA9IDE7XG5PYnNlcnZlSGFuZGxlID0gZnVuY3Rpb24gKG11bHRpcGxleGVyLCBjYWxsYmFja3MpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICAvLyBUaGUgZW5kIHVzZXIgaXMgb25seSBzdXBwb3NlZCB0byBjYWxsIHN0b3AoKS4gIFRoZSBvdGhlciBmaWVsZHMgYXJlXG4gIC8vIGFjY2Vzc2libGUgdG8gdGhlIG11bHRpcGxleGVyLCB0aG91Z2guXG4gIHNlbGYuX211bHRpcGxleGVyID0gbXVsdGlwbGV4ZXI7XG4gIF8uZWFjaChtdWx0aXBsZXhlci5jYWxsYmFja05hbWVzKCksIGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgaWYgKGNhbGxiYWNrc1tuYW1lXSkge1xuICAgICAgc2VsZlsnXycgKyBuYW1lXSA9IGNhbGxiYWNrc1tuYW1lXTtcbiAgICB9IGVsc2UgaWYgKG5hbWUgPT09IFwiYWRkZWRCZWZvcmVcIiAmJiBjYWxsYmFja3MuYWRkZWQpIHtcbiAgICAgIC8vIFNwZWNpYWwgY2FzZTogaWYgeW91IHNwZWNpZnkgXCJhZGRlZFwiIGFuZCBcIm1vdmVkQmVmb3JlXCIsIHlvdSBnZXQgYW5cbiAgICAgIC8vIG9yZGVyZWQgb2JzZXJ2ZSB3aGVyZSBmb3Igc29tZSByZWFzb24geW91IGRvbid0IGdldCBvcmRlcmluZyBkYXRhIG9uXG4gICAgICAvLyB0aGUgYWRkcy4gIEkgZHVubm8sIHdlIHdyb3RlIHRlc3RzIGZvciBpdCwgdGhlcmUgbXVzdCBoYXZlIGJlZW4gYVxuICAgICAgLy8gcmVhc29uLlxuICAgICAgc2VsZi5fYWRkZWRCZWZvcmUgPSBmdW5jdGlvbiAoaWQsIGZpZWxkcywgYmVmb3JlKSB7XG4gICAgICAgIGNhbGxiYWNrcy5hZGRlZChpZCwgZmllbGRzKTtcbiAgICAgIH07XG4gICAgfVxuICB9KTtcbiAgc2VsZi5fc3RvcHBlZCA9IGZhbHNlO1xuICBzZWxmLl9pZCA9IG5leHRPYnNlcnZlSGFuZGxlSWQrKztcbn07XG5PYnNlcnZlSGFuZGxlLnByb3RvdHlwZS5zdG9wID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgIHJldHVybjtcbiAgc2VsZi5fc3RvcHBlZCA9IHRydWU7XG4gIHNlbGYuX211bHRpcGxleGVyLnJlbW92ZUhhbmRsZShzZWxmLl9pZCk7XG59O1xuIiwidmFyIEZpYmVyID0gTnBtLnJlcXVpcmUoJ2ZpYmVycycpO1xuXG5leHBvcnQgY2xhc3MgRG9jRmV0Y2hlciB7XG4gIGNvbnN0cnVjdG9yKG1vbmdvQ29ubmVjdGlvbikge1xuICAgIHRoaXMuX21vbmdvQ29ubmVjdGlvbiA9IG1vbmdvQ29ubmVjdGlvbjtcbiAgICAvLyBNYXAgZnJvbSBvcCAtPiBbY2FsbGJhY2tdXG4gICAgdGhpcy5fY2FsbGJhY2tzRm9yT3AgPSBuZXcgTWFwO1xuICB9XG5cbiAgLy8gRmV0Y2hlcyBkb2N1bWVudCBcImlkXCIgZnJvbSBjb2xsZWN0aW9uTmFtZSwgcmV0dXJuaW5nIGl0IG9yIG51bGwgaWYgbm90XG4gIC8vIGZvdW5kLlxuICAvL1xuICAvLyBJZiB5b3UgbWFrZSBtdWx0aXBsZSBjYWxscyB0byBmZXRjaCgpIHdpdGggdGhlIHNhbWUgb3AgcmVmZXJlbmNlLFxuICAvLyBEb2NGZXRjaGVyIG1heSBhc3N1bWUgdGhhdCB0aGV5IGFsbCByZXR1cm4gdGhlIHNhbWUgZG9jdW1lbnQuIChJdCBkb2VzXG4gIC8vIG5vdCBjaGVjayB0byBzZWUgaWYgY29sbGVjdGlvbk5hbWUvaWQgbWF0Y2guKVxuICAvL1xuICAvLyBZb3UgbWF5IGFzc3VtZSB0aGF0IGNhbGxiYWNrIGlzIG5ldmVyIGNhbGxlZCBzeW5jaHJvbm91c2x5IChhbmQgaW4gZmFjdFxuICAvLyBPcGxvZ09ic2VydmVEcml2ZXIgZG9lcyBzbykuXG4gIGZldGNoKGNvbGxlY3Rpb25OYW1lLCBpZCwgb3AsIGNhbGxiYWNrKSB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG5cbiAgICBjaGVjayhjb2xsZWN0aW9uTmFtZSwgU3RyaW5nKTtcbiAgICBjaGVjayhvcCwgT2JqZWN0KTtcblxuICAgIC8vIElmIHRoZXJlJ3MgYWxyZWFkeSBhbiBpbi1wcm9ncmVzcyBmZXRjaCBmb3IgdGhpcyBjYWNoZSBrZXksIHlpZWxkIHVudGlsXG4gICAgLy8gaXQncyBkb25lIGFuZCByZXR1cm4gd2hhdGV2ZXIgaXQgcmV0dXJucy5cbiAgICBpZiAoc2VsZi5fY2FsbGJhY2tzRm9yT3AuaGFzKG9wKSkge1xuICAgICAgc2VsZi5fY2FsbGJhY2tzRm9yT3AuZ2V0KG9wKS5wdXNoKGNhbGxiYWNrKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBjYWxsYmFja3MgPSBbY2FsbGJhY2tdO1xuICAgIHNlbGYuX2NhbGxiYWNrc0Zvck9wLnNldChvcCwgY2FsbGJhY2tzKTtcblxuICAgIEZpYmVyKGZ1bmN0aW9uICgpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHZhciBkb2MgPSBzZWxmLl9tb25nb0Nvbm5lY3Rpb24uZmluZE9uZShcbiAgICAgICAgICBjb2xsZWN0aW9uTmFtZSwge19pZDogaWR9KSB8fCBudWxsO1xuICAgICAgICAvLyBSZXR1cm4gZG9jIHRvIGFsbCByZWxldmFudCBjYWxsYmFja3MuIE5vdGUgdGhhdCB0aGlzIGFycmF5IGNhblxuICAgICAgICAvLyBjb250aW51ZSB0byBncm93IGR1cmluZyBjYWxsYmFjayBleGNlY3V0aW9uLlxuICAgICAgICB3aGlsZSAoY2FsbGJhY2tzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAvLyBDbG9uZSB0aGUgZG9jdW1lbnQgc28gdGhhdCB0aGUgdmFyaW91cyBjYWxscyB0byBmZXRjaCBkb24ndCByZXR1cm5cbiAgICAgICAgICAvLyBvYmplY3RzIHRoYXQgYXJlIGludGVydHdpbmdsZWQgd2l0aCBlYWNoIG90aGVyLiBDbG9uZSBiZWZvcmVcbiAgICAgICAgICAvLyBwb3BwaW5nIHRoZSBmdXR1cmUsIHNvIHRoYXQgaWYgY2xvbmUgdGhyb3dzLCB0aGUgZXJyb3IgZ2V0cyBwYXNzZWRcbiAgICAgICAgICAvLyB0byB0aGUgbmV4dCBjYWxsYmFjay5cbiAgICAgICAgICBjYWxsYmFja3MucG9wKCkobnVsbCwgRUpTT04uY2xvbmUoZG9jKSk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgd2hpbGUgKGNhbGxiYWNrcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgY2FsbGJhY2tzLnBvcCgpKGUpO1xuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICAvLyBYWFggY29uc2lkZXIga2VlcGluZyB0aGUgZG9jIGFyb3VuZCBmb3IgYSBwZXJpb2Qgb2YgdGltZSBiZWZvcmVcbiAgICAgICAgLy8gcmVtb3ZpbmcgZnJvbSB0aGUgY2FjaGVcbiAgICAgICAgc2VsZi5fY2FsbGJhY2tzRm9yT3AuZGVsZXRlKG9wKTtcbiAgICAgIH1cbiAgICB9KS5ydW4oKTtcbiAgfVxufVxuIiwidmFyIFBPTExJTkdfVEhST1RUTEVfTVMgPSArcHJvY2Vzcy5lbnYuTUVURU9SX1BPTExJTkdfVEhST1RUTEVfTVMgfHwgNTA7XG52YXIgUE9MTElOR19JTlRFUlZBTF9NUyA9ICtwcm9jZXNzLmVudi5NRVRFT1JfUE9MTElOR19JTlRFUlZBTF9NUyB8fCAxMCAqIDEwMDA7XG5cblBvbGxpbmdPYnNlcnZlRHJpdmVyID0gZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uID0gb3B0aW9ucy5jdXJzb3JEZXNjcmlwdGlvbjtcbiAgc2VsZi5fbW9uZ29IYW5kbGUgPSBvcHRpb25zLm1vbmdvSGFuZGxlO1xuICBzZWxmLl9vcmRlcmVkID0gb3B0aW9ucy5vcmRlcmVkO1xuICBzZWxmLl9tdWx0aXBsZXhlciA9IG9wdGlvbnMubXVsdGlwbGV4ZXI7XG4gIHNlbGYuX3N0b3BDYWxsYmFja3MgPSBbXTtcbiAgc2VsZi5fc3RvcHBlZCA9IGZhbHNlO1xuXG4gIHNlbGYuX3N5bmNocm9ub3VzQ3Vyc29yID0gc2VsZi5fbW9uZ29IYW5kbGUuX2NyZWF0ZVN5bmNocm9ub3VzQ3Vyc29yKFxuICAgIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uKTtcblxuICAvLyBwcmV2aW91cyByZXN1bHRzIHNuYXBzaG90LiAgb24gZWFjaCBwb2xsIGN5Y2xlLCBkaWZmcyBhZ2FpbnN0XG4gIC8vIHJlc3VsdHMgZHJpdmVzIHRoZSBjYWxsYmFja3MuXG4gIHNlbGYuX3Jlc3VsdHMgPSBudWxsO1xuXG4gIC8vIFRoZSBudW1iZXIgb2YgX3BvbGxNb25nbyBjYWxscyB0aGF0IGhhdmUgYmVlbiBhZGRlZCB0byBzZWxmLl90YXNrUXVldWUgYnV0XG4gIC8vIGhhdmUgbm90IHN0YXJ0ZWQgcnVubmluZy4gVXNlZCB0byBtYWtlIHN1cmUgd2UgbmV2ZXIgc2NoZWR1bGUgbW9yZSB0aGFuIG9uZVxuICAvLyBfcG9sbE1vbmdvIChvdGhlciB0aGFuIHBvc3NpYmx5IHRoZSBvbmUgdGhhdCBpcyBjdXJyZW50bHkgcnVubmluZykuIEl0J3NcbiAgLy8gYWxzbyB1c2VkIGJ5IF9zdXNwZW5kUG9sbGluZyB0byBwcmV0ZW5kIHRoZXJlJ3MgYSBwb2xsIHNjaGVkdWxlZC4gVXN1YWxseSxcbiAgLy8gaXQncyBlaXRoZXIgMCAoZm9yIFwibm8gcG9sbHMgc2NoZWR1bGVkIG90aGVyIHRoYW4gbWF5YmUgb25lIGN1cnJlbnRseVxuICAvLyBydW5uaW5nXCIpIG9yIDEgKGZvciBcImEgcG9sbCBzY2hlZHVsZWQgdGhhdCBpc24ndCBydW5uaW5nIHlldFwiKSwgYnV0IGl0IGNhblxuICAvLyBhbHNvIGJlIDIgaWYgaW5jcmVtZW50ZWQgYnkgX3N1c3BlbmRQb2xsaW5nLlxuICBzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgPSAwO1xuICBzZWxmLl9wZW5kaW5nV3JpdGVzID0gW107IC8vIHBlb3BsZSB0byBub3RpZnkgd2hlbiBwb2xsaW5nIGNvbXBsZXRlc1xuXG4gIC8vIE1ha2Ugc3VyZSB0byBjcmVhdGUgYSBzZXBhcmF0ZWx5IHRocm90dGxlZCBmdW5jdGlvbiBmb3IgZWFjaFxuICAvLyBQb2xsaW5nT2JzZXJ2ZURyaXZlciBvYmplY3QuXG4gIHNlbGYuX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCA9IF8udGhyb3R0bGUoXG4gICAgc2VsZi5fdW50aHJvdHRsZWRFbnN1cmVQb2xsSXNTY2hlZHVsZWQsXG4gICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5wb2xsaW5nVGhyb3R0bGVNcyB8fCBQT0xMSU5HX1RIUk9UVExFX01TIC8qIG1zICovKTtcblxuICAvLyBYWFggZmlndXJlIG91dCBpZiB3ZSBzdGlsbCBuZWVkIGEgcXVldWVcbiAgc2VsZi5fdGFza1F1ZXVlID0gbmV3IE1ldGVvci5fU3luY2hyb25vdXNRdWV1ZSgpO1xuXG4gIHZhciBsaXN0ZW5lcnNIYW5kbGUgPSBsaXN0ZW5BbGwoXG4gICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24sIGZ1bmN0aW9uIChub3RpZmljYXRpb24pIHtcbiAgICAgIC8vIFdoZW4gc29tZW9uZSBkb2VzIGEgdHJhbnNhY3Rpb24gdGhhdCBtaWdodCBhZmZlY3QgdXMsIHNjaGVkdWxlIGEgcG9sbFxuICAgICAgLy8gb2YgdGhlIGRhdGFiYXNlLiBJZiB0aGF0IHRyYW5zYWN0aW9uIGhhcHBlbnMgaW5zaWRlIG9mIGEgd3JpdGUgZmVuY2UsXG4gICAgICAvLyBibG9jayB0aGUgZmVuY2UgdW50aWwgd2UndmUgcG9sbGVkIGFuZCBub3RpZmllZCBvYnNlcnZlcnMuXG4gICAgICB2YXIgZmVuY2UgPSBERFBTZXJ2ZXIuX0N1cnJlbnRXcml0ZUZlbmNlLmdldCgpO1xuICAgICAgaWYgKGZlbmNlKVxuICAgICAgICBzZWxmLl9wZW5kaW5nV3JpdGVzLnB1c2goZmVuY2UuYmVnaW5Xcml0ZSgpKTtcbiAgICAgIC8vIEVuc3VyZSBhIHBvbGwgaXMgc2NoZWR1bGVkLi4uIGJ1dCBpZiB3ZSBhbHJlYWR5IGtub3cgdGhhdCBvbmUgaXMsXG4gICAgICAvLyBkb24ndCBoaXQgdGhlIHRocm90dGxlZCBfZW5zdXJlUG9sbElzU2NoZWR1bGVkIGZ1bmN0aW9uICh3aGljaCBtaWdodFxuICAgICAgLy8gbGVhZCB0byB1cyBjYWxsaW5nIGl0IHVubmVjZXNzYXJpbHkgaW4gPHBvbGxpbmdUaHJvdHRsZU1zPiBtcykuXG4gICAgICBpZiAoc2VsZi5fcG9sbHNTY2hlZHVsZWRCdXROb3RTdGFydGVkID09PSAwKVxuICAgICAgICBzZWxmLl9lbnN1cmVQb2xsSXNTY2hlZHVsZWQoKTtcbiAgICB9XG4gICk7XG4gIHNlbGYuX3N0b3BDYWxsYmFja3MucHVzaChmdW5jdGlvbiAoKSB7IGxpc3RlbmVyc0hhbmRsZS5zdG9wKCk7IH0pO1xuXG4gIC8vIGV2ZXJ5IG9uY2UgYW5kIGEgd2hpbGUsIHBvbGwgZXZlbiBpZiB3ZSBkb24ndCB0aGluayB3ZSdyZSBkaXJ0eSwgZm9yXG4gIC8vIGV2ZW50dWFsIGNvbnNpc3RlbmN5IHdpdGggZGF0YWJhc2Ugd3JpdGVzIGZyb20gb3V0c2lkZSB0aGUgTWV0ZW9yXG4gIC8vIHVuaXZlcnNlLlxuICAvL1xuICAvLyBGb3IgdGVzdGluZywgdGhlcmUncyBhbiB1bmRvY3VtZW50ZWQgY2FsbGJhY2sgYXJndW1lbnQgdG8gb2JzZXJ2ZUNoYW5nZXNcbiAgLy8gd2hpY2ggZGlzYWJsZXMgdGltZS1iYXNlZCBwb2xsaW5nIGFuZCBnZXRzIGNhbGxlZCBhdCB0aGUgYmVnaW5uaW5nIG9mIGVhY2hcbiAgLy8gcG9sbC5cbiAgaWYgKG9wdGlvbnMuX3Rlc3RPbmx5UG9sbENhbGxiYWNrKSB7XG4gICAgc2VsZi5fdGVzdE9ubHlQb2xsQ2FsbGJhY2sgPSBvcHRpb25zLl90ZXN0T25seVBvbGxDYWxsYmFjaztcbiAgfSBlbHNlIHtcbiAgICB2YXIgcG9sbGluZ0ludGVydmFsID1cbiAgICAgICAgICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLnBvbGxpbmdJbnRlcnZhbE1zIHx8XG4gICAgICAgICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5fcG9sbGluZ0ludGVydmFsIHx8IC8vIENPTVBBVCB3aXRoIDEuMlxuICAgICAgICAgIFBPTExJTkdfSU5URVJWQUxfTVM7XG4gICAgdmFyIGludGVydmFsSGFuZGxlID0gTWV0ZW9yLnNldEludGVydmFsKFxuICAgICAgXy5iaW5kKHNlbGYuX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCwgc2VsZiksIHBvbGxpbmdJbnRlcnZhbCk7XG4gICAgc2VsZi5fc3RvcENhbGxiYWNrcy5wdXNoKGZ1bmN0aW9uICgpIHtcbiAgICAgIE1ldGVvci5jbGVhckludGVydmFsKGludGVydmFsSGFuZGxlKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIE1ha2Ugc3VyZSB3ZSBhY3R1YWxseSBwb2xsIHNvb24hXG4gIHNlbGYuX3VudGhyb3R0bGVkRW5zdXJlUG9sbElzU2NoZWR1bGVkKCk7XG5cbiAgUGFja2FnZVsnZmFjdHMtYmFzZSddICYmIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXS5GYWN0cy5pbmNyZW1lbnRTZXJ2ZXJGYWN0KFxuICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLWRyaXZlcnMtcG9sbGluZ1wiLCAxKTtcbn07XG5cbl8uZXh0ZW5kKFBvbGxpbmdPYnNlcnZlRHJpdmVyLnByb3RvdHlwZSwge1xuICAvLyBUaGlzIGlzIGFsd2F5cyBjYWxsZWQgdGhyb3VnaCBfLnRocm90dGxlIChleGNlcHQgb25jZSBhdCBzdGFydHVwKS5cbiAgX3VudGhyb3R0bGVkRW5zdXJlUG9sbElzU2NoZWR1bGVkOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgPiAwKVxuICAgICAgcmV0dXJuO1xuICAgICsrc2VsZi5fcG9sbHNTY2hlZHVsZWRCdXROb3RTdGFydGVkO1xuICAgIHNlbGYuX3Rhc2tRdWV1ZS5xdWV1ZVRhc2soZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fcG9sbE1vbmdvKCk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gdGVzdC1vbmx5IGludGVyZmFjZSBmb3IgY29udHJvbGxpbmcgcG9sbGluZy5cbiAgLy9cbiAgLy8gX3N1c3BlbmRQb2xsaW5nIGJsb2NrcyB1bnRpbCBhbnkgY3VycmVudGx5IHJ1bm5pbmcgYW5kIHNjaGVkdWxlZCBwb2xscyBhcmVcbiAgLy8gZG9uZSwgYW5kIHByZXZlbnRzIGFueSBmdXJ0aGVyIHBvbGxzIGZyb20gYmVpbmcgc2NoZWR1bGVkLiAobmV3XG4gIC8vIE9ic2VydmVIYW5kbGVzIGNhbiBiZSBhZGRlZCBhbmQgcmVjZWl2ZSB0aGVpciBpbml0aWFsIGFkZGVkIGNhbGxiYWNrcyxcbiAgLy8gdGhvdWdoLilcbiAgLy9cbiAgLy8gX3Jlc3VtZVBvbGxpbmcgaW1tZWRpYXRlbHkgcG9sbHMsIGFuZCBhbGxvd3MgZnVydGhlciBwb2xscyB0byBvY2N1ci5cbiAgX3N1c3BlbmRQb2xsaW5nOiBmdW5jdGlvbigpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gUHJldGVuZCB0aGF0IHRoZXJlJ3MgYW5vdGhlciBwb2xsIHNjaGVkdWxlZCAod2hpY2ggd2lsbCBwcmV2ZW50XG4gICAgLy8gX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCBmcm9tIHF1ZXVlaW5nIGFueSBtb3JlIHBvbGxzKS5cbiAgICArK3NlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZDtcbiAgICAvLyBOb3cgYmxvY2sgdW50aWwgYWxsIGN1cnJlbnRseSBydW5uaW5nIG9yIHNjaGVkdWxlZCBwb2xscyBhcmUgZG9uZS5cbiAgICBzZWxmLl90YXNrUXVldWUucnVuVGFzayhmdW5jdGlvbigpIHt9KTtcblxuICAgIC8vIENvbmZpcm0gdGhhdCB0aGVyZSBpcyBvbmx5IG9uZSBcInBvbGxcIiAodGhlIGZha2Ugb25lIHdlJ3JlIHByZXRlbmRpbmcgdG9cbiAgICAvLyBoYXZlKSBzY2hlZHVsZWQuXG4gICAgaWYgKHNlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCAhPT0gMSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgaXMgXCIgK1xuICAgICAgICAgICAgICAgICAgICAgIHNlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCk7XG4gIH0sXG4gIF9yZXN1bWVQb2xsaW5nOiBmdW5jdGlvbigpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gV2Ugc2hvdWxkIGJlIGluIHRoZSBzYW1lIHN0YXRlIGFzIGluIHRoZSBlbmQgb2YgX3N1c3BlbmRQb2xsaW5nLlxuICAgIGlmIChzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgIT09IDEpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJfcG9sbHNTY2hlZHVsZWRCdXROb3RTdGFydGVkIGlzIFwiICtcbiAgICAgICAgICAgICAgICAgICAgICBzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQpO1xuICAgIC8vIFJ1biBhIHBvbGwgc3luY2hyb25vdXNseSAod2hpY2ggd2lsbCBjb3VudGVyYWN0IHRoZVxuICAgIC8vICsrX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCBmcm9tIF9zdXNwZW5kUG9sbGluZykuXG4gICAgc2VsZi5fdGFza1F1ZXVlLnJ1blRhc2soZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fcG9sbE1vbmdvKCk7XG4gICAgfSk7XG4gIH0sXG5cbiAgX3BvbGxNb25nbzogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAtLXNlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZDtcblxuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgcmV0dXJuO1xuXG4gICAgdmFyIGZpcnN0ID0gZmFsc2U7XG4gICAgdmFyIG5ld1Jlc3VsdHM7XG4gICAgdmFyIG9sZFJlc3VsdHMgPSBzZWxmLl9yZXN1bHRzO1xuICAgIGlmICghb2xkUmVzdWx0cykge1xuICAgICAgZmlyc3QgPSB0cnVlO1xuICAgICAgLy8gWFhYIG1heWJlIHVzZSBPcmRlcmVkRGljdCBpbnN0ZWFkP1xuICAgICAgb2xkUmVzdWx0cyA9IHNlbGYuX29yZGVyZWQgPyBbXSA6IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgIH1cblxuICAgIHNlbGYuX3Rlc3RPbmx5UG9sbENhbGxiYWNrICYmIHNlbGYuX3Rlc3RPbmx5UG9sbENhbGxiYWNrKCk7XG5cbiAgICAvLyBTYXZlIHRoZSBsaXN0IG9mIHBlbmRpbmcgd3JpdGVzIHdoaWNoIHRoaXMgcm91bmQgd2lsbCBjb21taXQuXG4gICAgdmFyIHdyaXRlc0ZvckN5Y2xlID0gc2VsZi5fcGVuZGluZ1dyaXRlcztcbiAgICBzZWxmLl9wZW5kaW5nV3JpdGVzID0gW107XG5cbiAgICAvLyBHZXQgdGhlIG5ldyBxdWVyeSByZXN1bHRzLiAoVGhpcyB5aWVsZHMuKVxuICAgIHRyeSB7XG4gICAgICBuZXdSZXN1bHRzID0gc2VsZi5fc3luY2hyb25vdXNDdXJzb3IuZ2V0UmF3T2JqZWN0cyhzZWxmLl9vcmRlcmVkKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZmlyc3QgJiYgdHlwZW9mKGUuY29kZSkgPT09ICdudW1iZXInKSB7XG4gICAgICAgIC8vIFRoaXMgaXMgYW4gZXJyb3IgZG9jdW1lbnQgc2VudCB0byB1cyBieSBtb25nb2QsIG5vdCBhIGNvbm5lY3Rpb25cbiAgICAgICAgLy8gZXJyb3IgZ2VuZXJhdGVkIGJ5IHRoZSBjbGllbnQuIEFuZCB3ZSd2ZSBuZXZlciBzZWVuIHRoaXMgcXVlcnkgd29ya1xuICAgICAgICAvLyBzdWNjZXNzZnVsbHkuIFByb2JhYmx5IGl0J3MgYSBiYWQgc2VsZWN0b3Igb3Igc29tZXRoaW5nLCBzbyB3ZSBzaG91bGRcbiAgICAgICAgLy8gTk9UIHJldHJ5LiBJbnN0ZWFkLCB3ZSBzaG91bGQgaGFsdCB0aGUgb2JzZXJ2ZSAod2hpY2ggZW5kcyB1cCBjYWxsaW5nXG4gICAgICAgIC8vIGBzdG9wYCBvbiB1cykuXG4gICAgICAgIHNlbGYuX211bHRpcGxleGVyLnF1ZXJ5RXJyb3IoXG4gICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJFeGNlcHRpb24gd2hpbGUgcG9sbGluZyBxdWVyeSBcIiArXG4gICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uKSArIFwiOiBcIiArIGUubWVzc2FnZSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIGdldFJhd09iamVjdHMgY2FuIHRocm93IGlmIHdlJ3JlIGhhdmluZyB0cm91YmxlIHRhbGtpbmcgdG8gdGhlXG4gICAgICAvLyBkYXRhYmFzZS4gIFRoYXQncyBmaW5lIC0tLSB3ZSB3aWxsIHJlcG9sbCBsYXRlciBhbnl3YXkuIEJ1dCB3ZSBzaG91bGRcbiAgICAgIC8vIG1ha2Ugc3VyZSBub3QgdG8gbG9zZSB0cmFjayBvZiB0aGlzIGN5Y2xlJ3Mgd3JpdGVzLlxuICAgICAgLy8gKEl0IGFsc28gY2FuIHRocm93IGlmIHRoZXJlJ3MganVzdCBzb21ldGhpbmcgaW52YWxpZCBhYm91dCB0aGlzIHF1ZXJ5O1xuICAgICAgLy8gdW5mb3J0dW5hdGVseSB0aGUgT2JzZXJ2ZURyaXZlciBBUEkgZG9lc24ndCBwcm92aWRlIGEgZ29vZCB3YXkgdG9cbiAgICAgIC8vIFwiY2FuY2VsXCIgdGhlIG9ic2VydmUgZnJvbSB0aGUgaW5zaWRlIGluIHRoaXMgY2FzZS5cbiAgICAgIEFycmF5LnByb3RvdHlwZS5wdXNoLmFwcGx5KHNlbGYuX3BlbmRpbmdXcml0ZXMsIHdyaXRlc0ZvckN5Y2xlKTtcbiAgICAgIE1ldGVvci5fZGVidWcoXCJFeGNlcHRpb24gd2hpbGUgcG9sbGluZyBxdWVyeSBcIiArXG4gICAgICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uKSwgZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gUnVuIGRpZmZzLlxuICAgIGlmICghc2VsZi5fc3RvcHBlZCkge1xuICAgICAgTG9jYWxDb2xsZWN0aW9uLl9kaWZmUXVlcnlDaGFuZ2VzKFxuICAgICAgICBzZWxmLl9vcmRlcmVkLCBvbGRSZXN1bHRzLCBuZXdSZXN1bHRzLCBzZWxmLl9tdWx0aXBsZXhlcik7XG4gICAgfVxuXG4gICAgLy8gU2lnbmFscyB0aGUgbXVsdGlwbGV4ZXIgdG8gYWxsb3cgYWxsIG9ic2VydmVDaGFuZ2VzIGNhbGxzIHRoYXQgc2hhcmUgdGhpc1xuICAgIC8vIG11bHRpcGxleGVyIHRvIHJldHVybi4gKFRoaXMgaGFwcGVucyBhc3luY2hyb25vdXNseSwgdmlhIHRoZVxuICAgIC8vIG11bHRpcGxleGVyJ3MgcXVldWUuKVxuICAgIGlmIChmaXJzdClcbiAgICAgIHNlbGYuX211bHRpcGxleGVyLnJlYWR5KCk7XG5cbiAgICAvLyBSZXBsYWNlIHNlbGYuX3Jlc3VsdHMgYXRvbWljYWxseS4gIChUaGlzIGFzc2lnbm1lbnQgaXMgd2hhdCBtYWtlcyBgZmlyc3RgXG4gICAgLy8gc3RheSB0aHJvdWdoIG9uIHRoZSBuZXh0IGN5Y2xlLCBzbyB3ZSd2ZSB3YWl0ZWQgdW50aWwgYWZ0ZXIgd2UndmVcbiAgICAvLyBjb21taXR0ZWQgdG8gcmVhZHktaW5nIHRoZSBtdWx0aXBsZXhlci4pXG4gICAgc2VsZi5fcmVzdWx0cyA9IG5ld1Jlc3VsdHM7XG5cbiAgICAvLyBPbmNlIHRoZSBPYnNlcnZlTXVsdGlwbGV4ZXIgaGFzIHByb2Nlc3NlZCBldmVyeXRoaW5nIHdlJ3ZlIGRvbmUgaW4gdGhpc1xuICAgIC8vIHJvdW5kLCBtYXJrIGFsbCB0aGUgd3JpdGVzIHdoaWNoIGV4aXN0ZWQgYmVmb3JlIHRoaXMgY2FsbCBhc1xuICAgIC8vIGNvbW1taXR0ZWQuIChJZiBuZXcgd3JpdGVzIGhhdmUgc2hvd24gdXAgaW4gdGhlIG1lYW50aW1lLCB0aGVyZSdsbFxuICAgIC8vIGFscmVhZHkgYmUgYW5vdGhlciBfcG9sbE1vbmdvIHRhc2sgc2NoZWR1bGVkLilcbiAgICBzZWxmLl9tdWx0aXBsZXhlci5vbkZsdXNoKGZ1bmN0aW9uICgpIHtcbiAgICAgIF8uZWFjaCh3cml0ZXNGb3JDeWNsZSwgZnVuY3Rpb24gKHcpIHtcbiAgICAgICAgdy5jb21taXR0ZWQoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9LFxuXG4gIHN0b3A6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgc2VsZi5fc3RvcHBlZCA9IHRydWU7XG4gICAgXy5lYWNoKHNlbGYuX3N0b3BDYWxsYmFja3MsIGZ1bmN0aW9uIChjKSB7IGMoKTsgfSk7XG4gICAgLy8gUmVsZWFzZSBhbnkgd3JpdGUgZmVuY2VzIHRoYXQgYXJlIHdhaXRpbmcgb24gdXMuXG4gICAgXy5lYWNoKHNlbGYuX3BlbmRpbmdXcml0ZXMsIGZ1bmN0aW9uICh3KSB7XG4gICAgICB3LmNvbW1pdHRlZCgpO1xuICAgIH0pO1xuICAgIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSAmJiBQYWNrYWdlWydmYWN0cy1iYXNlJ10uRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLWRyaXZlcnMtcG9sbGluZ1wiLCAtMSk7XG4gIH1cbn0pO1xuIiwidmFyIEZ1dHVyZSA9IE5wbS5yZXF1aXJlKCdmaWJlcnMvZnV0dXJlJyk7XG5cbnZhciBQSEFTRSA9IHtcbiAgUVVFUllJTkc6IFwiUVVFUllJTkdcIixcbiAgRkVUQ0hJTkc6IFwiRkVUQ0hJTkdcIixcbiAgU1RFQURZOiBcIlNURUFEWVwiXG59O1xuXG4vLyBFeGNlcHRpb24gdGhyb3duIGJ5IF9uZWVkVG9Qb2xsUXVlcnkgd2hpY2ggdW5yb2xscyB0aGUgc3RhY2sgdXAgdG8gdGhlXG4vLyBlbmNsb3NpbmcgY2FsbCB0byBmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeS5cbnZhciBTd2l0Y2hlZFRvUXVlcnkgPSBmdW5jdGlvbiAoKSB7fTtcbnZhciBmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeSA9IGZ1bmN0aW9uIChmKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGYuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoIShlIGluc3RhbmNlb2YgU3dpdGNoZWRUb1F1ZXJ5KSlcbiAgICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH07XG59O1xuXG52YXIgY3VycmVudElkID0gMDtcblxuLy8gT3Bsb2dPYnNlcnZlRHJpdmVyIGlzIGFuIGFsdGVybmF0aXZlIHRvIFBvbGxpbmdPYnNlcnZlRHJpdmVyIHdoaWNoIGZvbGxvd3Ncbi8vIHRoZSBNb25nbyBvcGVyYXRpb24gbG9nIGluc3RlYWQgb2YganVzdCByZS1wb2xsaW5nIHRoZSBxdWVyeS4gSXQgb2JleXMgdGhlXG4vLyBzYW1lIHNpbXBsZSBpbnRlcmZhY2U6IGNvbnN0cnVjdGluZyBpdCBzdGFydHMgc2VuZGluZyBvYnNlcnZlQ2hhbmdlc1xuLy8gY2FsbGJhY2tzIChhbmQgYSByZWFkeSgpIGludm9jYXRpb24pIHRvIHRoZSBPYnNlcnZlTXVsdGlwbGV4ZXIsIGFuZCB5b3Ugc3RvcFxuLy8gaXQgYnkgY2FsbGluZyB0aGUgc3RvcCgpIG1ldGhvZC5cbk9wbG9nT2JzZXJ2ZURyaXZlciA9IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgc2VsZi5fdXNlc09wbG9nID0gdHJ1ZTsgIC8vIHRlc3RzIGxvb2sgYXQgdGhpc1xuXG4gIHNlbGYuX2lkID0gY3VycmVudElkO1xuICBjdXJyZW50SWQrKztcblxuICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbiA9IG9wdGlvbnMuY3Vyc29yRGVzY3JpcHRpb247XG4gIHNlbGYuX21vbmdvSGFuZGxlID0gb3B0aW9ucy5tb25nb0hhbmRsZTtcbiAgc2VsZi5fbXVsdGlwbGV4ZXIgPSBvcHRpb25zLm11bHRpcGxleGVyO1xuXG4gIGlmIChvcHRpb25zLm9yZGVyZWQpIHtcbiAgICB0aHJvdyBFcnJvcihcIk9wbG9nT2JzZXJ2ZURyaXZlciBvbmx5IHN1cHBvcnRzIHVub3JkZXJlZCBvYnNlcnZlQ2hhbmdlc1wiKTtcbiAgfVxuXG4gIHZhciBzb3J0ZXIgPSBvcHRpb25zLnNvcnRlcjtcbiAgLy8gV2UgZG9uJ3Qgc3VwcG9ydCAkbmVhciBhbmQgb3RoZXIgZ2VvLXF1ZXJpZXMgc28gaXQncyBPSyB0byBpbml0aWFsaXplIHRoZVxuICAvLyBjb21wYXJhdG9yIG9ubHkgb25jZSBpbiB0aGUgY29uc3RydWN0b3IuXG4gIHZhciBjb21wYXJhdG9yID0gc29ydGVyICYmIHNvcnRlci5nZXRDb21wYXJhdG9yKCk7XG5cbiAgaWYgKG9wdGlvbnMuY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5saW1pdCkge1xuICAgIC8vIFRoZXJlIGFyZSBzZXZlcmFsIHByb3BlcnRpZXMgb3JkZXJlZCBkcml2ZXIgaW1wbGVtZW50czpcbiAgICAvLyAtIF9saW1pdCBpcyBhIHBvc2l0aXZlIG51bWJlclxuICAgIC8vIC0gX2NvbXBhcmF0b3IgaXMgYSBmdW5jdGlvbi1jb21wYXJhdG9yIGJ5IHdoaWNoIHRoZSBxdWVyeSBpcyBvcmRlcmVkXG4gICAgLy8gLSBfdW5wdWJsaXNoZWRCdWZmZXIgaXMgbm9uLW51bGwgTWluL01heCBIZWFwLFxuICAgIC8vICAgICAgICAgICAgICAgICAgICAgIHRoZSBlbXB0eSBidWZmZXIgaW4gU1RFQURZIHBoYXNlIGltcGxpZXMgdGhhdCB0aGVcbiAgICAvLyAgICAgICAgICAgICAgICAgICAgICBldmVyeXRoaW5nIHRoYXQgbWF0Y2hlcyB0aGUgcXVlcmllcyBzZWxlY3RvciBmaXRzXG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgaW50byBwdWJsaXNoZWQgc2V0LlxuICAgIC8vIC0gX3B1Ymxpc2hlZCAtIE1pbiBIZWFwIChhbHNvIGltcGxlbWVudHMgSWRNYXAgbWV0aG9kcylcblxuICAgIHZhciBoZWFwT3B0aW9ucyA9IHsgSWRNYXA6IExvY2FsQ29sbGVjdGlvbi5fSWRNYXAgfTtcbiAgICBzZWxmLl9saW1pdCA9IHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMubGltaXQ7XG4gICAgc2VsZi5fY29tcGFyYXRvciA9IGNvbXBhcmF0b3I7XG4gICAgc2VsZi5fc29ydGVyID0gc29ydGVyO1xuICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyID0gbmV3IE1pbk1heEhlYXAoY29tcGFyYXRvciwgaGVhcE9wdGlvbnMpO1xuICAgIC8vIFdlIG5lZWQgc29tZXRoaW5nIHRoYXQgY2FuIGZpbmQgTWF4IHZhbHVlIGluIGFkZGl0aW9uIHRvIElkTWFwIGludGVyZmFjZVxuICAgIHNlbGYuX3B1Ymxpc2hlZCA9IG5ldyBNYXhIZWFwKGNvbXBhcmF0b3IsIGhlYXBPcHRpb25zKTtcbiAgfSBlbHNlIHtcbiAgICBzZWxmLl9saW1pdCA9IDA7XG4gICAgc2VsZi5fY29tcGFyYXRvciA9IG51bGw7XG4gICAgc2VsZi5fc29ydGVyID0gbnVsbDtcbiAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlciA9IG51bGw7XG4gICAgc2VsZi5fcHVibGlzaGVkID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG4gIH1cblxuICAvLyBJbmRpY2F0ZXMgaWYgaXQgaXMgc2FmZSB0byBpbnNlcnQgYSBuZXcgZG9jdW1lbnQgYXQgdGhlIGVuZCBvZiB0aGUgYnVmZmVyXG4gIC8vIGZvciB0aGlzIHF1ZXJ5LiBpLmUuIGl0IGlzIGtub3duIHRoYXQgdGhlcmUgYXJlIG5vIGRvY3VtZW50cyBtYXRjaGluZyB0aGVcbiAgLy8gc2VsZWN0b3IgdGhvc2UgYXJlIG5vdCBpbiBwdWJsaXNoZWQgb3IgYnVmZmVyLlxuICBzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIgPSBmYWxzZTtcblxuICBzZWxmLl9zdG9wcGVkID0gZmFsc2U7XG4gIHNlbGYuX3N0b3BIYW5kbGVzID0gW107XG5cbiAgUGFja2FnZVsnZmFjdHMtYmFzZSddICYmIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXS5GYWN0cy5pbmNyZW1lbnRTZXJ2ZXJGYWN0KFxuICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLWRyaXZlcnMtb3Bsb2dcIiwgMSk7XG5cbiAgc2VsZi5fcmVnaXN0ZXJQaGFzZUNoYW5nZShQSEFTRS5RVUVSWUlORyk7XG5cbiAgc2VsZi5fbWF0Y2hlciA9IG9wdGlvbnMubWF0Y2hlcjtcbiAgdmFyIHByb2plY3Rpb24gPSBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLmZpZWxkcyB8fCB7fTtcbiAgc2VsZi5fcHJvamVjdGlvbkZuID0gTG9jYWxDb2xsZWN0aW9uLl9jb21waWxlUHJvamVjdGlvbihwcm9qZWN0aW9uKTtcbiAgLy8gUHJvamVjdGlvbiBmdW5jdGlvbiwgcmVzdWx0IG9mIGNvbWJpbmluZyBpbXBvcnRhbnQgZmllbGRzIGZvciBzZWxlY3RvciBhbmRcbiAgLy8gZXhpc3RpbmcgZmllbGRzIHByb2plY3Rpb25cbiAgc2VsZi5fc2hhcmVkUHJvamVjdGlvbiA9IHNlbGYuX21hdGNoZXIuY29tYmluZUludG9Qcm9qZWN0aW9uKHByb2plY3Rpb24pO1xuICBpZiAoc29ydGVyKVxuICAgIHNlbGYuX3NoYXJlZFByb2plY3Rpb24gPSBzb3J0ZXIuY29tYmluZUludG9Qcm9qZWN0aW9uKHNlbGYuX3NoYXJlZFByb2plY3Rpb24pO1xuICBzZWxmLl9zaGFyZWRQcm9qZWN0aW9uRm4gPSBMb2NhbENvbGxlY3Rpb24uX2NvbXBpbGVQcm9qZWN0aW9uKFxuICAgIHNlbGYuX3NoYXJlZFByb2plY3Rpb24pO1xuXG4gIHNlbGYuX25lZWRUb0ZldGNoID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG4gIHNlbGYuX2N1cnJlbnRseUZldGNoaW5nID0gbnVsbDtcbiAgc2VsZi5fZmV0Y2hHZW5lcmF0aW9uID0gMDtcblxuICBzZWxmLl9yZXF1ZXJ5V2hlbkRvbmVUaGlzUXVlcnkgPSBmYWxzZTtcbiAgc2VsZi5fd3JpdGVzVG9Db21taXRXaGVuV2VSZWFjaFN0ZWFkeSA9IFtdO1xuXG4gIC8vIElmIHRoZSBvcGxvZyBoYW5kbGUgdGVsbHMgdXMgdGhhdCBpdCBza2lwcGVkIHNvbWUgZW50cmllcyAoYmVjYXVzZSBpdCBnb3RcbiAgLy8gYmVoaW5kLCBzYXkpLCByZS1wb2xsLlxuICBzZWxmLl9zdG9wSGFuZGxlcy5wdXNoKHNlbGYuX21vbmdvSGFuZGxlLl9vcGxvZ0hhbmRsZS5vblNraXBwZWRFbnRyaWVzKFxuICAgIGZpbmlzaElmTmVlZFRvUG9sbFF1ZXJ5KGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX25lZWRUb1BvbGxRdWVyeSgpO1xuICAgIH0pXG4gICkpO1xuXG4gIGZvckVhY2hUcmlnZ2VyKHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLCBmdW5jdGlvbiAodHJpZ2dlcikge1xuICAgIHNlbGYuX3N0b3BIYW5kbGVzLnB1c2goc2VsZi5fbW9uZ29IYW5kbGUuX29wbG9nSGFuZGxlLm9uT3Bsb2dFbnRyeShcbiAgICAgIHRyaWdnZXIsIGZ1bmN0aW9uIChub3RpZmljYXRpb24pIHtcbiAgICAgICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnkoZnVuY3Rpb24gKCkge1xuICAgICAgICAgIHZhciBvcCA9IG5vdGlmaWNhdGlvbi5vcDtcbiAgICAgICAgICBpZiAobm90aWZpY2F0aW9uLmRyb3BDb2xsZWN0aW9uIHx8IG5vdGlmaWNhdGlvbi5kcm9wRGF0YWJhc2UpIHtcbiAgICAgICAgICAgIC8vIE5vdGU6IHRoaXMgY2FsbCBpcyBub3QgYWxsb3dlZCB0byBibG9jayBvbiBhbnl0aGluZyAoZXNwZWNpYWxseVxuICAgICAgICAgICAgLy8gb24gd2FpdGluZyBmb3Igb3Bsb2cgZW50cmllcyB0byBjYXRjaCB1cCkgYmVjYXVzZSB0aGF0IHdpbGwgYmxvY2tcbiAgICAgICAgICAgIC8vIG9uT3Bsb2dFbnRyeSFcbiAgICAgICAgICAgIHNlbGYuX25lZWRUb1BvbGxRdWVyeSgpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBBbGwgb3RoZXIgb3BlcmF0b3JzIHNob3VsZCBiZSBoYW5kbGVkIGRlcGVuZGluZyBvbiBwaGFzZVxuICAgICAgICAgICAgaWYgKHNlbGYuX3BoYXNlID09PSBQSEFTRS5RVUVSWUlORykge1xuICAgICAgICAgICAgICBzZWxmLl9oYW5kbGVPcGxvZ0VudHJ5UXVlcnlpbmcob3ApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgc2VsZi5faGFuZGxlT3Bsb2dFbnRyeVN0ZWFkeU9yRmV0Y2hpbmcob3ApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgICAgfVxuICAgICkpO1xuICB9KTtcblxuICAvLyBYWFggb3JkZXJpbmcgdy5yLnQuIGV2ZXJ5dGhpbmcgZWxzZT9cbiAgc2VsZi5fc3RvcEhhbmRsZXMucHVzaChsaXN0ZW5BbGwoXG4gICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24sIGZ1bmN0aW9uIChub3RpZmljYXRpb24pIHtcbiAgICAgIC8vIElmIHdlJ3JlIG5vdCBpbiBhIHByZS1maXJlIHdyaXRlIGZlbmNlLCB3ZSBkb24ndCBoYXZlIHRvIGRvIGFueXRoaW5nLlxuICAgICAgdmFyIGZlbmNlID0gRERQU2VydmVyLl9DdXJyZW50V3JpdGVGZW5jZS5nZXQoKTtcbiAgICAgIGlmICghZmVuY2UgfHwgZmVuY2UuZmlyZWQpXG4gICAgICAgIHJldHVybjtcblxuICAgICAgaWYgKGZlbmNlLl9vcGxvZ09ic2VydmVEcml2ZXJzKSB7XG4gICAgICAgIGZlbmNlLl9vcGxvZ09ic2VydmVEcml2ZXJzW3NlbGYuX2lkXSA9IHNlbGY7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgZmVuY2UuX29wbG9nT2JzZXJ2ZURyaXZlcnMgPSB7fTtcbiAgICAgIGZlbmNlLl9vcGxvZ09ic2VydmVEcml2ZXJzW3NlbGYuX2lkXSA9IHNlbGY7XG5cbiAgICAgIGZlbmNlLm9uQmVmb3JlRmlyZShmdW5jdGlvbiAoKSB7XG4gICAgICAgIHZhciBkcml2ZXJzID0gZmVuY2UuX29wbG9nT2JzZXJ2ZURyaXZlcnM7XG4gICAgICAgIGRlbGV0ZSBmZW5jZS5fb3Bsb2dPYnNlcnZlRHJpdmVycztcblxuICAgICAgICAvLyBUaGlzIGZlbmNlIGNhbm5vdCBmaXJlIHVudGlsIHdlJ3ZlIGNhdWdodCB1cCB0byBcInRoaXMgcG9pbnRcIiBpbiB0aGVcbiAgICAgICAgLy8gb3Bsb2csIGFuZCBhbGwgb2JzZXJ2ZXJzIG1hZGUgaXQgYmFjayB0byB0aGUgc3RlYWR5IHN0YXRlLlxuICAgICAgICBzZWxmLl9tb25nb0hhbmRsZS5fb3Bsb2dIYW5kbGUud2FpdFVudGlsQ2F1Z2h0VXAoKTtcblxuICAgICAgICBfLmVhY2goZHJpdmVycywgZnVuY3Rpb24gKGRyaXZlcikge1xuICAgICAgICAgIGlmIChkcml2ZXIuX3N0b3BwZWQpXG4gICAgICAgICAgICByZXR1cm47XG5cbiAgICAgICAgICB2YXIgd3JpdGUgPSBmZW5jZS5iZWdpbldyaXRlKCk7XG4gICAgICAgICAgaWYgKGRyaXZlci5fcGhhc2UgPT09IFBIQVNFLlNURUFEWSkge1xuICAgICAgICAgICAgLy8gTWFrZSBzdXJlIHRoYXQgYWxsIG9mIHRoZSBjYWxsYmFja3MgaGF2ZSBtYWRlIGl0IHRocm91Z2ggdGhlXG4gICAgICAgICAgICAvLyBtdWx0aXBsZXhlciBhbmQgYmVlbiBkZWxpdmVyZWQgdG8gT2JzZXJ2ZUhhbmRsZXMgYmVmb3JlIGNvbW1pdHRpbmdcbiAgICAgICAgICAgIC8vIHdyaXRlcy5cbiAgICAgICAgICAgIGRyaXZlci5fbXVsdGlwbGV4ZXIub25GbHVzaChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgIHdyaXRlLmNvbW1pdHRlZCgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGRyaXZlci5fd3JpdGVzVG9Db21taXRXaGVuV2VSZWFjaFN0ZWFkeS5wdXNoKHdyaXRlKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfVxuICApKTtcblxuICAvLyBXaGVuIE1vbmdvIGZhaWxzIG92ZXIsIHdlIG5lZWQgdG8gcmVwb2xsIHRoZSBxdWVyeSwgaW4gY2FzZSB3ZSBwcm9jZXNzZWQgYW5cbiAgLy8gb3Bsb2cgZW50cnkgdGhhdCBnb3Qgcm9sbGVkIGJhY2suXG4gIHNlbGYuX3N0b3BIYW5kbGVzLnB1c2goc2VsZi5fbW9uZ29IYW5kbGUuX29uRmFpbG92ZXIoZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnkoXG4gICAgZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fbmVlZFRvUG9sbFF1ZXJ5KCk7XG4gICAgfSkpKTtcblxuICAvLyBHaXZlIF9vYnNlcnZlQ2hhbmdlcyBhIGNoYW5jZSB0byBhZGQgdGhlIG5ldyBPYnNlcnZlSGFuZGxlIHRvIG91clxuICAvLyBtdWx0aXBsZXhlciwgc28gdGhhdCB0aGUgYWRkZWQgY2FsbHMgZ2V0IHN0cmVhbWVkLlxuICBNZXRlb3IuZGVmZXIoZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnkoZnVuY3Rpb24gKCkge1xuICAgIHNlbGYuX3J1bkluaXRpYWxRdWVyeSgpO1xuICB9KSk7XG59O1xuXG5fLmV4dGVuZChPcGxvZ09ic2VydmVEcml2ZXIucHJvdG90eXBlLCB7XG4gIF9hZGRQdWJsaXNoZWQ6IGZ1bmN0aW9uIChpZCwgZG9jKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBmaWVsZHMgPSBfLmNsb25lKGRvYyk7XG4gICAgICBkZWxldGUgZmllbGRzLl9pZDtcbiAgICAgIHNlbGYuX3B1Ymxpc2hlZC5zZXQoaWQsIHNlbGYuX3NoYXJlZFByb2plY3Rpb25Gbihkb2MpKTtcbiAgICAgIHNlbGYuX211bHRpcGxleGVyLmFkZGVkKGlkLCBzZWxmLl9wcm9qZWN0aW9uRm4oZmllbGRzKSk7XG5cbiAgICAgIC8vIEFmdGVyIGFkZGluZyB0aGlzIGRvY3VtZW50LCB0aGUgcHVibGlzaGVkIHNldCBtaWdodCBiZSBvdmVyZmxvd2VkXG4gICAgICAvLyAoZXhjZWVkaW5nIGNhcGFjaXR5IHNwZWNpZmllZCBieSBsaW1pdCkuIElmIHNvLCBwdXNoIHRoZSBtYXhpbXVtXG4gICAgICAvLyBlbGVtZW50IHRvIHRoZSBidWZmZXIsIHdlIG1pZ2h0IHdhbnQgdG8gc2F2ZSBpdCBpbiBtZW1vcnkgdG8gcmVkdWNlIHRoZVxuICAgICAgLy8gYW1vdW50IG9mIE1vbmdvIGxvb2t1cHMgaW4gdGhlIGZ1dHVyZS5cbiAgICAgIGlmIChzZWxmLl9saW1pdCAmJiBzZWxmLl9wdWJsaXNoZWQuc2l6ZSgpID4gc2VsZi5fbGltaXQpIHtcbiAgICAgICAgLy8gWFhYIGluIHRoZW9yeSB0aGUgc2l6ZSBvZiBwdWJsaXNoZWQgaXMgbm8gbW9yZSB0aGFuIGxpbWl0KzFcbiAgICAgICAgaWYgKHNlbGYuX3B1Ymxpc2hlZC5zaXplKCkgIT09IHNlbGYuX2xpbWl0ICsgMSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFmdGVyIGFkZGluZyB0byBwdWJsaXNoZWQsIFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgKHNlbGYuX3B1Ymxpc2hlZC5zaXplKCkgLSBzZWxmLl9saW1pdCkgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICBcIiBkb2N1bWVudHMgYXJlIG92ZXJmbG93aW5nIHRoZSBzZXRcIik7XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgb3ZlcmZsb3dpbmdEb2NJZCA9IHNlbGYuX3B1Ymxpc2hlZC5tYXhFbGVtZW50SWQoKTtcbiAgICAgICAgdmFyIG92ZXJmbG93aW5nRG9jID0gc2VsZi5fcHVibGlzaGVkLmdldChvdmVyZmxvd2luZ0RvY0lkKTtcblxuICAgICAgICBpZiAoRUpTT04uZXF1YWxzKG92ZXJmbG93aW5nRG9jSWQsIGlkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlRoZSBkb2N1bWVudCBqdXN0IGFkZGVkIGlzIG92ZXJmbG93aW5nIHRoZSBwdWJsaXNoZWQgc2V0XCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgc2VsZi5fcHVibGlzaGVkLnJlbW92ZShvdmVyZmxvd2luZ0RvY0lkKTtcbiAgICAgICAgc2VsZi5fbXVsdGlwbGV4ZXIucmVtb3ZlZChvdmVyZmxvd2luZ0RvY0lkKTtcbiAgICAgICAgc2VsZi5fYWRkQnVmZmVyZWQob3ZlcmZsb3dpbmdEb2NJZCwgb3ZlcmZsb3dpbmdEb2MpO1xuICAgICAgfVxuICAgIH0pO1xuICB9LFxuICBfcmVtb3ZlUHVibGlzaGVkOiBmdW5jdGlvbiAoaWQpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fcHVibGlzaGVkLnJlbW92ZShpZCk7XG4gICAgICBzZWxmLl9tdWx0aXBsZXhlci5yZW1vdmVkKGlkKTtcbiAgICAgIGlmICghIHNlbGYuX2xpbWl0IHx8IHNlbGYuX3B1Ymxpc2hlZC5zaXplKCkgPT09IHNlbGYuX2xpbWl0KVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIGlmIChzZWxmLl9wdWJsaXNoZWQuc2l6ZSgpID4gc2VsZi5fbGltaXQpXG4gICAgICAgIHRocm93IEVycm9yKFwic2VsZi5fcHVibGlzaGVkIGdvdCB0b28gYmlnXCIpO1xuXG4gICAgICAvLyBPSywgd2UgYXJlIHB1Ymxpc2hpbmcgbGVzcyB0aGFuIHRoZSBsaW1pdC4gTWF5YmUgd2Ugc2hvdWxkIGxvb2sgaW4gdGhlXG4gICAgICAvLyBidWZmZXIgdG8gZmluZCB0aGUgbmV4dCBlbGVtZW50IHBhc3Qgd2hhdCB3ZSB3ZXJlIHB1Ymxpc2hpbmcgYmVmb3JlLlxuXG4gICAgICBpZiAoIXNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmVtcHR5KCkpIHtcbiAgICAgICAgLy8gVGhlcmUncyBzb21ldGhpbmcgaW4gdGhlIGJ1ZmZlcjsgbW92ZSB0aGUgZmlyc3QgdGhpbmcgaW4gaXQgdG9cbiAgICAgICAgLy8gX3B1Ymxpc2hlZC5cbiAgICAgICAgdmFyIG5ld0RvY0lkID0gc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIubWluRWxlbWVudElkKCk7XG4gICAgICAgIHZhciBuZXdEb2MgPSBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5nZXQobmV3RG9jSWQpO1xuICAgICAgICBzZWxmLl9yZW1vdmVCdWZmZXJlZChuZXdEb2NJZCk7XG4gICAgICAgIHNlbGYuX2FkZFB1Ymxpc2hlZChuZXdEb2NJZCwgbmV3RG9jKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBUaGVyZSdzIG5vdGhpbmcgaW4gdGhlIGJ1ZmZlci4gIFRoaXMgY291bGQgbWVhbiBvbmUgb2YgYSBmZXcgdGhpbmdzLlxuXG4gICAgICAvLyAoYSkgV2UgY291bGQgYmUgaW4gdGhlIG1pZGRsZSBvZiByZS1ydW5uaW5nIHRoZSBxdWVyeSAoc3BlY2lmaWNhbGx5LCB3ZVxuICAgICAgLy8gY291bGQgYmUgaW4gX3B1Ymxpc2hOZXdSZXN1bHRzKS4gSW4gdGhhdCBjYXNlLCBfdW5wdWJsaXNoZWRCdWZmZXIgaXNcbiAgICAgIC8vIGVtcHR5IGJlY2F1c2Ugd2UgY2xlYXIgaXQgYXQgdGhlIGJlZ2lubmluZyBvZiBfcHVibGlzaE5ld1Jlc3VsdHMuIEluXG4gICAgICAvLyB0aGlzIGNhc2UsIG91ciBjYWxsZXIgYWxyZWFkeSBrbm93cyB0aGUgZW50aXJlIGFuc3dlciB0byB0aGUgcXVlcnkgYW5kXG4gICAgICAvLyB3ZSBkb24ndCBuZWVkIHRvIGRvIGFueXRoaW5nIGZhbmN5IGhlcmUuICBKdXN0IHJldHVybi5cbiAgICAgIGlmIChzZWxmLl9waGFzZSA9PT0gUEhBU0UuUVVFUllJTkcpXG4gICAgICAgIHJldHVybjtcblxuICAgICAgLy8gKGIpIFdlJ3JlIHByZXR0eSBjb25maWRlbnQgdGhhdCB0aGUgdW5pb24gb2YgX3B1Ymxpc2hlZCBhbmRcbiAgICAgIC8vIF91bnB1Ymxpc2hlZEJ1ZmZlciBjb250YWluIGFsbCBkb2N1bWVudHMgdGhhdCBtYXRjaCBzZWxlY3Rvci4gQmVjYXVzZVxuICAgICAgLy8gX3VucHVibGlzaGVkQnVmZmVyIGlzIGVtcHR5LCB0aGF0IG1lYW5zIHdlJ3JlIGNvbmZpZGVudCB0aGF0IF9wdWJsaXNoZWRcbiAgICAgIC8vIGNvbnRhaW5zIGFsbCBkb2N1bWVudHMgdGhhdCBtYXRjaCBzZWxlY3Rvci4gU28gd2UgaGF2ZSBub3RoaW5nIHRvIGRvLlxuICAgICAgaWYgKHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlcilcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICAvLyAoYykgTWF5YmUgdGhlcmUgYXJlIG90aGVyIGRvY3VtZW50cyBvdXQgdGhlcmUgdGhhdCBzaG91bGQgYmUgaW4gb3VyXG4gICAgICAvLyBidWZmZXIuIEJ1dCBpbiB0aGF0IGNhc2UsIHdoZW4gd2UgZW1wdGllZCBfdW5wdWJsaXNoZWRCdWZmZXIgaW5cbiAgICAgIC8vIF9yZW1vdmVCdWZmZXJlZCwgd2Ugc2hvdWxkIGhhdmUgY2FsbGVkIF9uZWVkVG9Qb2xsUXVlcnksIHdoaWNoIHdpbGxcbiAgICAgIC8vIGVpdGhlciBwdXQgc29tZXRoaW5nIGluIF91bnB1Ymxpc2hlZEJ1ZmZlciBvciBzZXQgX3NhZmVBcHBlbmRUb0J1ZmZlclxuICAgICAgLy8gKG9yIGJvdGgpLCBhbmQgaXQgd2lsbCBwdXQgdXMgaW4gUVVFUllJTkcgZm9yIHRoYXQgd2hvbGUgdGltZS4gU28gaW5cbiAgICAgIC8vIGZhY3QsIHdlIHNob3VsZG4ndCBiZSBhYmxlIHRvIGdldCBoZXJlLlxuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJCdWZmZXIgaW5leHBsaWNhYmx5IGVtcHR5XCIpO1xuICAgIH0pO1xuICB9LFxuICBfY2hhbmdlUHVibGlzaGVkOiBmdW5jdGlvbiAoaWQsIG9sZERvYywgbmV3RG9jKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX3B1Ymxpc2hlZC5zZXQoaWQsIHNlbGYuX3NoYXJlZFByb2plY3Rpb25GbihuZXdEb2MpKTtcbiAgICAgIHZhciBwcm9qZWN0ZWROZXcgPSBzZWxmLl9wcm9qZWN0aW9uRm4obmV3RG9jKTtcbiAgICAgIHZhciBwcm9qZWN0ZWRPbGQgPSBzZWxmLl9wcm9qZWN0aW9uRm4ob2xkRG9jKTtcbiAgICAgIHZhciBjaGFuZ2VkID0gRGlmZlNlcXVlbmNlLm1ha2VDaGFuZ2VkRmllbGRzKFxuICAgICAgICBwcm9qZWN0ZWROZXcsIHByb2plY3RlZE9sZCk7XG4gICAgICBpZiAoIV8uaXNFbXB0eShjaGFuZ2VkKSlcbiAgICAgICAgc2VsZi5fbXVsdGlwbGV4ZXIuY2hhbmdlZChpZCwgY2hhbmdlZCk7XG4gICAgfSk7XG4gIH0sXG4gIF9hZGRCdWZmZXJlZDogZnVuY3Rpb24gKGlkLCBkb2MpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuc2V0KGlkLCBzZWxmLl9zaGFyZWRQcm9qZWN0aW9uRm4oZG9jKSk7XG5cbiAgICAgIC8vIElmIHNvbWV0aGluZyBpcyBvdmVyZmxvd2luZyB0aGUgYnVmZmVyLCB3ZSBqdXN0IHJlbW92ZSBpdCBmcm9tIGNhY2hlXG4gICAgICBpZiAoc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuc2l6ZSgpID4gc2VsZi5fbGltaXQpIHtcbiAgICAgICAgdmFyIG1heEJ1ZmZlcmVkSWQgPSBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5tYXhFbGVtZW50SWQoKTtcblxuICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5yZW1vdmUobWF4QnVmZmVyZWRJZCk7XG5cbiAgICAgICAgLy8gU2luY2Ugc29tZXRoaW5nIG1hdGNoaW5nIGlzIHJlbW92ZWQgZnJvbSBjYWNoZSAoYm90aCBwdWJsaXNoZWQgc2V0IGFuZFxuICAgICAgICAvLyBidWZmZXIpLCBzZXQgZmxhZyB0byBmYWxzZVxuICAgICAgICBzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcbiAgLy8gSXMgY2FsbGVkIGVpdGhlciB0byByZW1vdmUgdGhlIGRvYyBjb21wbGV0ZWx5IGZyb20gbWF0Y2hpbmcgc2V0IG9yIHRvIG1vdmVcbiAgLy8gaXQgdG8gdGhlIHB1Ymxpc2hlZCBzZXQgbGF0ZXIuXG4gIF9yZW1vdmVCdWZmZXJlZDogZnVuY3Rpb24gKGlkKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnJlbW92ZShpZCk7XG4gICAgICAvLyBUbyBrZWVwIHRoZSBjb250cmFjdCBcImJ1ZmZlciBpcyBuZXZlciBlbXB0eSBpbiBTVEVBRFkgcGhhc2UgdW5sZXNzIHRoZVxuICAgICAgLy8gZXZlcnl0aGluZyBtYXRjaGluZyBmaXRzIGludG8gcHVibGlzaGVkXCIgdHJ1ZSwgd2UgcG9sbCBldmVyeXRoaW5nIGFzXG4gICAgICAvLyBzb29uIGFzIHdlIHNlZSB0aGUgYnVmZmVyIGJlY29taW5nIGVtcHR5LlxuICAgICAgaWYgKCEgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuc2l6ZSgpICYmICEgc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyKVxuICAgICAgICBzZWxmLl9uZWVkVG9Qb2xsUXVlcnkoKTtcbiAgICB9KTtcbiAgfSxcbiAgLy8gQ2FsbGVkIHdoZW4gYSBkb2N1bWVudCBoYXMgam9pbmVkIHRoZSBcIk1hdGNoaW5nXCIgcmVzdWx0cyBzZXQuXG4gIC8vIFRha2VzIHJlc3BvbnNpYmlsaXR5IG9mIGtlZXBpbmcgX3VucHVibGlzaGVkQnVmZmVyIGluIHN5bmMgd2l0aCBfcHVibGlzaGVkXG4gIC8vIGFuZCB0aGUgZWZmZWN0IG9mIGxpbWl0IGVuZm9yY2VkLlxuICBfYWRkTWF0Y2hpbmc6IGZ1bmN0aW9uIChkb2MpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIGlkID0gZG9jLl9pZDtcbiAgICAgIGlmIChzZWxmLl9wdWJsaXNoZWQuaGFzKGlkKSlcbiAgICAgICAgdGhyb3cgRXJyb3IoXCJ0cmllZCB0byBhZGQgc29tZXRoaW5nIGFscmVhZHkgcHVibGlzaGVkIFwiICsgaWQpO1xuICAgICAgaWYgKHNlbGYuX2xpbWl0ICYmIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmhhcyhpZCkpXG4gICAgICAgIHRocm93IEVycm9yKFwidHJpZWQgdG8gYWRkIHNvbWV0aGluZyBhbHJlYWR5IGV4aXN0ZWQgaW4gYnVmZmVyIFwiICsgaWQpO1xuXG4gICAgICB2YXIgbGltaXQgPSBzZWxmLl9saW1pdDtcbiAgICAgIHZhciBjb21wYXJhdG9yID0gc2VsZi5fY29tcGFyYXRvcjtcbiAgICAgIHZhciBtYXhQdWJsaXNoZWQgPSAobGltaXQgJiYgc2VsZi5fcHVibGlzaGVkLnNpemUoKSA+IDApID9cbiAgICAgICAgc2VsZi5fcHVibGlzaGVkLmdldChzZWxmLl9wdWJsaXNoZWQubWF4RWxlbWVudElkKCkpIDogbnVsbDtcbiAgICAgIHZhciBtYXhCdWZmZXJlZCA9IChsaW1pdCAmJiBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5zaXplKCkgPiAwKVxuICAgICAgICA/IHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmdldChzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5tYXhFbGVtZW50SWQoKSlcbiAgICAgICAgOiBudWxsO1xuICAgICAgLy8gVGhlIHF1ZXJ5IGlzIHVubGltaXRlZCBvciBkaWRuJ3QgcHVibGlzaCBlbm91Z2ggZG9jdW1lbnRzIHlldCBvciB0aGVcbiAgICAgIC8vIG5ldyBkb2N1bWVudCB3b3VsZCBmaXQgaW50byBwdWJsaXNoZWQgc2V0IHB1c2hpbmcgdGhlIG1heGltdW0gZWxlbWVudFxuICAgICAgLy8gb3V0LCB0aGVuIHdlIG5lZWQgdG8gcHVibGlzaCB0aGUgZG9jLlxuICAgICAgdmFyIHRvUHVibGlzaCA9ICEgbGltaXQgfHwgc2VsZi5fcHVibGlzaGVkLnNpemUoKSA8IGxpbWl0IHx8XG4gICAgICAgIGNvbXBhcmF0b3IoZG9jLCBtYXhQdWJsaXNoZWQpIDwgMDtcblxuICAgICAgLy8gT3RoZXJ3aXNlIHdlIG1pZ2h0IG5lZWQgdG8gYnVmZmVyIGl0IChvbmx5IGluIGNhc2Ugb2YgbGltaXRlZCBxdWVyeSkuXG4gICAgICAvLyBCdWZmZXJpbmcgaXMgYWxsb3dlZCBpZiB0aGUgYnVmZmVyIGlzIG5vdCBmaWxsZWQgdXAgeWV0IGFuZCBhbGxcbiAgICAgIC8vIG1hdGNoaW5nIGRvY3MgYXJlIGVpdGhlciBpbiB0aGUgcHVibGlzaGVkIHNldCBvciBpbiB0aGUgYnVmZmVyLlxuICAgICAgdmFyIGNhbkFwcGVuZFRvQnVmZmVyID0gIXRvUHVibGlzaCAmJiBzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIgJiZcbiAgICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuc2l6ZSgpIDwgbGltaXQ7XG5cbiAgICAgIC8vIE9yIGlmIGl0IGlzIHNtYWxsIGVub3VnaCB0byBiZSBzYWZlbHkgaW5zZXJ0ZWQgdG8gdGhlIG1pZGRsZSBvciB0aGVcbiAgICAgIC8vIGJlZ2lubmluZyBvZiB0aGUgYnVmZmVyLlxuICAgICAgdmFyIGNhbkluc2VydEludG9CdWZmZXIgPSAhdG9QdWJsaXNoICYmIG1heEJ1ZmZlcmVkICYmXG4gICAgICAgIGNvbXBhcmF0b3IoZG9jLCBtYXhCdWZmZXJlZCkgPD0gMDtcblxuICAgICAgdmFyIHRvQnVmZmVyID0gY2FuQXBwZW5kVG9CdWZmZXIgfHwgY2FuSW5zZXJ0SW50b0J1ZmZlcjtcblxuICAgICAgaWYgKHRvUHVibGlzaCkge1xuICAgICAgICBzZWxmLl9hZGRQdWJsaXNoZWQoaWQsIGRvYyk7XG4gICAgICB9IGVsc2UgaWYgKHRvQnVmZmVyKSB7XG4gICAgICAgIHNlbGYuX2FkZEJ1ZmZlcmVkKGlkLCBkb2MpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gZHJvcHBpbmcgaXQgYW5kIG5vdCBzYXZpbmcgdG8gdGhlIGNhY2hlXG4gICAgICAgIHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlciA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICB9LFxuICAvLyBDYWxsZWQgd2hlbiBhIGRvY3VtZW50IGxlYXZlcyB0aGUgXCJNYXRjaGluZ1wiIHJlc3VsdHMgc2V0LlxuICAvLyBUYWtlcyByZXNwb25zaWJpbGl0eSBvZiBrZWVwaW5nIF91bnB1Ymxpc2hlZEJ1ZmZlciBpbiBzeW5jIHdpdGggX3B1Ymxpc2hlZFxuICAvLyBhbmQgdGhlIGVmZmVjdCBvZiBsaW1pdCBlbmZvcmNlZC5cbiAgX3JlbW92ZU1hdGNoaW5nOiBmdW5jdGlvbiAoaWQpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKCEgc2VsZi5fcHVibGlzaGVkLmhhcyhpZCkgJiYgISBzZWxmLl9saW1pdClcbiAgICAgICAgdGhyb3cgRXJyb3IoXCJ0cmllZCB0byByZW1vdmUgc29tZXRoaW5nIG1hdGNoaW5nIGJ1dCBub3QgY2FjaGVkIFwiICsgaWQpO1xuXG4gICAgICBpZiAoc2VsZi5fcHVibGlzaGVkLmhhcyhpZCkpIHtcbiAgICAgICAgc2VsZi5fcmVtb3ZlUHVibGlzaGVkKGlkKTtcbiAgICAgIH0gZWxzZSBpZiAoc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuaGFzKGlkKSkge1xuICAgICAgICBzZWxmLl9yZW1vdmVCdWZmZXJlZChpZCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG4gIF9oYW5kbGVEb2M6IGZ1bmN0aW9uIChpZCwgbmV3RG9jKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBtYXRjaGVzTm93ID0gbmV3RG9jICYmIHNlbGYuX21hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKG5ld0RvYykucmVzdWx0O1xuXG4gICAgICB2YXIgcHVibGlzaGVkQmVmb3JlID0gc2VsZi5fcHVibGlzaGVkLmhhcyhpZCk7XG4gICAgICB2YXIgYnVmZmVyZWRCZWZvcmUgPSBzZWxmLl9saW1pdCAmJiBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5oYXMoaWQpO1xuICAgICAgdmFyIGNhY2hlZEJlZm9yZSA9IHB1Ymxpc2hlZEJlZm9yZSB8fCBidWZmZXJlZEJlZm9yZTtcblxuICAgICAgaWYgKG1hdGNoZXNOb3cgJiYgIWNhY2hlZEJlZm9yZSkge1xuICAgICAgICBzZWxmLl9hZGRNYXRjaGluZyhuZXdEb2MpO1xuICAgICAgfSBlbHNlIGlmIChjYWNoZWRCZWZvcmUgJiYgIW1hdGNoZXNOb3cpIHtcbiAgICAgICAgc2VsZi5fcmVtb3ZlTWF0Y2hpbmcoaWQpO1xuICAgICAgfSBlbHNlIGlmIChjYWNoZWRCZWZvcmUgJiYgbWF0Y2hlc05vdykge1xuICAgICAgICB2YXIgb2xkRG9jID0gc2VsZi5fcHVibGlzaGVkLmdldChpZCk7XG4gICAgICAgIHZhciBjb21wYXJhdG9yID0gc2VsZi5fY29tcGFyYXRvcjtcbiAgICAgICAgdmFyIG1pbkJ1ZmZlcmVkID0gc2VsZi5fbGltaXQgJiYgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuc2l6ZSgpICYmXG4gICAgICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuZ2V0KHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLm1pbkVsZW1lbnRJZCgpKTtcbiAgICAgICAgdmFyIG1heEJ1ZmZlcmVkO1xuXG4gICAgICAgIGlmIChwdWJsaXNoZWRCZWZvcmUpIHtcbiAgICAgICAgICAvLyBVbmxpbWl0ZWQgY2FzZSB3aGVyZSB0aGUgZG9jdW1lbnQgc3RheXMgaW4gcHVibGlzaGVkIG9uY2UgaXRcbiAgICAgICAgICAvLyBtYXRjaGVzIG9yIHRoZSBjYXNlIHdoZW4gd2UgZG9uJ3QgaGF2ZSBlbm91Z2ggbWF0Y2hpbmcgZG9jcyB0b1xuICAgICAgICAgIC8vIHB1Ymxpc2ggb3IgdGhlIGNoYW5nZWQgYnV0IG1hdGNoaW5nIGRvYyB3aWxsIHN0YXkgaW4gcHVibGlzaGVkXG4gICAgICAgICAgLy8gYW55d2F5cy5cbiAgICAgICAgICAvL1xuICAgICAgICAgIC8vIFhYWDogV2UgcmVseSBvbiB0aGUgZW1wdGluZXNzIG9mIGJ1ZmZlci4gQmUgc3VyZSB0byBtYWludGFpbiB0aGVcbiAgICAgICAgICAvLyBmYWN0IHRoYXQgYnVmZmVyIGNhbid0IGJlIGVtcHR5IGlmIHRoZXJlIGFyZSBtYXRjaGluZyBkb2N1bWVudHMgbm90XG4gICAgICAgICAgLy8gcHVibGlzaGVkLiBOb3RhYmx5LCB3ZSBkb24ndCB3YW50IHRvIHNjaGVkdWxlIHJlcG9sbCBhbmQgY29udGludWVcbiAgICAgICAgICAvLyByZWx5aW5nIG9uIHRoaXMgcHJvcGVydHkuXG4gICAgICAgICAgdmFyIHN0YXlzSW5QdWJsaXNoZWQgPSAhIHNlbGYuX2xpbWl0IHx8XG4gICAgICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5zaXplKCkgPT09IDAgfHxcbiAgICAgICAgICAgIGNvbXBhcmF0b3IobmV3RG9jLCBtaW5CdWZmZXJlZCkgPD0gMDtcblxuICAgICAgICAgIGlmIChzdGF5c0luUHVibGlzaGVkKSB7XG4gICAgICAgICAgICBzZWxmLl9jaGFuZ2VQdWJsaXNoZWQoaWQsIG9sZERvYywgbmV3RG9jKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gYWZ0ZXIgdGhlIGNoYW5nZSBkb2MgZG9lc24ndCBzdGF5IGluIHRoZSBwdWJsaXNoZWQsIHJlbW92ZSBpdFxuICAgICAgICAgICAgc2VsZi5fcmVtb3ZlUHVibGlzaGVkKGlkKTtcbiAgICAgICAgICAgIC8vIGJ1dCBpdCBjYW4gbW92ZSBpbnRvIGJ1ZmZlcmVkIG5vdywgY2hlY2sgaXRcbiAgICAgICAgICAgIG1heEJ1ZmZlcmVkID0gc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuZ2V0KFxuICAgICAgICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5tYXhFbGVtZW50SWQoKSk7XG5cbiAgICAgICAgICAgIHZhciB0b0J1ZmZlciA9IHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlciB8fFxuICAgICAgICAgICAgICAgICAgKG1heEJ1ZmZlcmVkICYmIGNvbXBhcmF0b3IobmV3RG9jLCBtYXhCdWZmZXJlZCkgPD0gMCk7XG5cbiAgICAgICAgICAgIGlmICh0b0J1ZmZlcikge1xuICAgICAgICAgICAgICBzZWxmLl9hZGRCdWZmZXJlZChpZCwgbmV3RG9jKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIC8vIFRocm93IGF3YXkgZnJvbSBib3RoIHB1Ymxpc2hlZCBzZXQgYW5kIGJ1ZmZlclxuICAgICAgICAgICAgICBzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIgPSBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoYnVmZmVyZWRCZWZvcmUpIHtcbiAgICAgICAgICBvbGREb2MgPSBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5nZXQoaWQpO1xuICAgICAgICAgIC8vIHJlbW92ZSB0aGUgb2xkIHZlcnNpb24gbWFudWFsbHkgaW5zdGVhZCBvZiB1c2luZyBfcmVtb3ZlQnVmZmVyZWQgc29cbiAgICAgICAgICAvLyB3ZSBkb24ndCB0cmlnZ2VyIHRoZSBxdWVyeWluZyBpbW1lZGlhdGVseS4gIGlmIHdlIGVuZCB0aGlzIGJsb2NrXG4gICAgICAgICAgLy8gd2l0aCB0aGUgYnVmZmVyIGVtcHR5LCB3ZSB3aWxsIG5lZWQgdG8gdHJpZ2dlciB0aGUgcXVlcnkgcG9sbFxuICAgICAgICAgIC8vIG1hbnVhbGx5IHRvby5cbiAgICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5yZW1vdmUoaWQpO1xuXG4gICAgICAgICAgdmFyIG1heFB1Ymxpc2hlZCA9IHNlbGYuX3B1Ymxpc2hlZC5nZXQoXG4gICAgICAgICAgICBzZWxmLl9wdWJsaXNoZWQubWF4RWxlbWVudElkKCkpO1xuICAgICAgICAgIG1heEJ1ZmZlcmVkID0gc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuc2l6ZSgpICYmXG4gICAgICAgICAgICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuZ2V0KFxuICAgICAgICAgICAgICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIubWF4RWxlbWVudElkKCkpO1xuXG4gICAgICAgICAgLy8gdGhlIGJ1ZmZlcmVkIGRvYyB3YXMgdXBkYXRlZCwgaXQgY291bGQgbW92ZSB0byBwdWJsaXNoZWRcbiAgICAgICAgICB2YXIgdG9QdWJsaXNoID0gY29tcGFyYXRvcihuZXdEb2MsIG1heFB1Ymxpc2hlZCkgPCAwO1xuXG4gICAgICAgICAgLy8gb3Igc3RheXMgaW4gYnVmZmVyIGV2ZW4gYWZ0ZXIgdGhlIGNoYW5nZVxuICAgICAgICAgIHZhciBzdGF5c0luQnVmZmVyID0gKCEgdG9QdWJsaXNoICYmIHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlcikgfHxcbiAgICAgICAgICAgICAgICAoIXRvUHVibGlzaCAmJiBtYXhCdWZmZXJlZCAmJlxuICAgICAgICAgICAgICAgICBjb21wYXJhdG9yKG5ld0RvYywgbWF4QnVmZmVyZWQpIDw9IDApO1xuXG4gICAgICAgICAgaWYgKHRvUHVibGlzaCkge1xuICAgICAgICAgICAgc2VsZi5fYWRkUHVibGlzaGVkKGlkLCBuZXdEb2MpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoc3RheXNJbkJ1ZmZlcikge1xuICAgICAgICAgICAgLy8gc3RheXMgaW4gYnVmZmVyIGJ1dCBjaGFuZ2VzXG4gICAgICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5zZXQoaWQsIG5ld0RvYyk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIFRocm93IGF3YXkgZnJvbSBib3RoIHB1Ymxpc2hlZCBzZXQgYW5kIGJ1ZmZlclxuICAgICAgICAgICAgc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyID0gZmFsc2U7XG4gICAgICAgICAgICAvLyBOb3JtYWxseSB0aGlzIGNoZWNrIHdvdWxkIGhhdmUgYmVlbiBkb25lIGluIF9yZW1vdmVCdWZmZXJlZCBidXRcbiAgICAgICAgICAgIC8vIHdlIGRpZG4ndCB1c2UgaXQsIHNvIHdlIG5lZWQgdG8gZG8gaXQgb3Vyc2VsZiBub3cuXG4gICAgICAgICAgICBpZiAoISBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5zaXplKCkpIHtcbiAgICAgICAgICAgICAgc2VsZi5fbmVlZFRvUG9sbFF1ZXJ5KCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcImNhY2hlZEJlZm9yZSBpbXBsaWVzIGVpdGhlciBvZiBwdWJsaXNoZWRCZWZvcmUgb3IgYnVmZmVyZWRCZWZvcmUgaXMgdHJ1ZS5cIik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcbiAgX2ZldGNoTW9kaWZpZWREb2N1bWVudHM6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fcmVnaXN0ZXJQaGFzZUNoYW5nZShQSEFTRS5GRVRDSElORyk7XG4gICAgICAvLyBEZWZlciwgYmVjYXVzZSBub3RoaW5nIGNhbGxlZCBmcm9tIHRoZSBvcGxvZyBlbnRyeSBoYW5kbGVyIG1heSB5aWVsZCxcbiAgICAgIC8vIGJ1dCBmZXRjaCgpIHlpZWxkcy5cbiAgICAgIE1ldGVvci5kZWZlcihmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeShmdW5jdGlvbiAoKSB7XG4gICAgICAgIHdoaWxlICghc2VsZi5fc3RvcHBlZCAmJiAhc2VsZi5fbmVlZFRvRmV0Y2guZW1wdHkoKSkge1xuICAgICAgICAgIGlmIChzZWxmLl9waGFzZSA9PT0gUEhBU0UuUVVFUllJTkcpIHtcbiAgICAgICAgICAgIC8vIFdoaWxlIGZldGNoaW5nLCB3ZSBkZWNpZGVkIHRvIGdvIGludG8gUVVFUllJTkcgbW9kZSwgYW5kIHRoZW4gd2VcbiAgICAgICAgICAgIC8vIHNhdyBhbm90aGVyIG9wbG9nIGVudHJ5LCBzbyBfbmVlZFRvRmV0Y2ggaXMgbm90IGVtcHR5LiBCdXQgd2VcbiAgICAgICAgICAgIC8vIHNob3VsZG4ndCBmZXRjaCB0aGVzZSBkb2N1bWVudHMgdW50aWwgQUZURVIgdGhlIHF1ZXJ5IGlzIGRvbmUuXG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBCZWluZyBpbiBzdGVhZHkgcGhhc2UgaGVyZSB3b3VsZCBiZSBzdXJwcmlzaW5nLlxuICAgICAgICAgIGlmIChzZWxmLl9waGFzZSAhPT0gUEhBU0UuRkVUQ0hJTkcpXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJwaGFzZSBpbiBmZXRjaE1vZGlmaWVkRG9jdW1lbnRzOiBcIiArIHNlbGYuX3BoYXNlKTtcblxuICAgICAgICAgIHNlbGYuX2N1cnJlbnRseUZldGNoaW5nID0gc2VsZi5fbmVlZFRvRmV0Y2g7XG4gICAgICAgICAgdmFyIHRoaXNHZW5lcmF0aW9uID0gKytzZWxmLl9mZXRjaEdlbmVyYXRpb247XG4gICAgICAgICAgc2VsZi5fbmVlZFRvRmV0Y2ggPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcDtcbiAgICAgICAgICB2YXIgd2FpdGluZyA9IDA7XG4gICAgICAgICAgdmFyIGZ1dCA9IG5ldyBGdXR1cmU7XG4gICAgICAgICAgLy8gVGhpcyBsb29wIGlzIHNhZmUsIGJlY2F1c2UgX2N1cnJlbnRseUZldGNoaW5nIHdpbGwgbm90IGJlIHVwZGF0ZWRcbiAgICAgICAgICAvLyBkdXJpbmcgdGhpcyBsb29wIChpbiBmYWN0LCBpdCBpcyBuZXZlciBtdXRhdGVkKS5cbiAgICAgICAgICBzZWxmLl9jdXJyZW50bHlGZXRjaGluZy5mb3JFYWNoKGZ1bmN0aW9uIChvcCwgaWQpIHtcbiAgICAgICAgICAgIHdhaXRpbmcrKztcbiAgICAgICAgICAgIHNlbGYuX21vbmdvSGFuZGxlLl9kb2NGZXRjaGVyLmZldGNoKFxuICAgICAgICAgICAgICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5jb2xsZWN0aW9uTmFtZSwgaWQsIG9wLFxuICAgICAgICAgICAgICBmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeShmdW5jdGlvbiAoZXJyLCBkb2MpIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgICAgICBNZXRlb3IuX2RlYnVnKFwiR290IGV4Y2VwdGlvbiB3aGlsZSBmZXRjaGluZyBkb2N1bWVudHNcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnIpO1xuICAgICAgICAgICAgICAgICAgICAvLyBJZiB3ZSBnZXQgYW4gZXJyb3IgZnJvbSB0aGUgZmV0Y2hlciAoZWcsIHRyb3VibGVcbiAgICAgICAgICAgICAgICAgICAgLy8gY29ubmVjdGluZyB0byBNb25nbyksIGxldCdzIGp1c3QgYWJhbmRvbiB0aGUgZmV0Y2ggcGhhc2VcbiAgICAgICAgICAgICAgICAgICAgLy8gYWx0b2dldGhlciBhbmQgZmFsbCBiYWNrIHRvIHBvbGxpbmcuIEl0J3Mgbm90IGxpa2Ugd2UncmVcbiAgICAgICAgICAgICAgICAgICAgLy8gZ2V0dGluZyBsaXZlIHVwZGF0ZXMgYW55d2F5LlxuICAgICAgICAgICAgICAgICAgICBpZiAoc2VsZi5fcGhhc2UgIT09IFBIQVNFLlFVRVJZSU5HKSB7XG4gICAgICAgICAgICAgICAgICAgICAgc2VsZi5fbmVlZFRvUG9sbFF1ZXJ5KCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoIXNlbGYuX3N0b3BwZWQgJiYgc2VsZi5fcGhhc2UgPT09IFBIQVNFLkZFVENISU5HXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICYmIHNlbGYuX2ZldGNoR2VuZXJhdGlvbiA9PT0gdGhpc0dlbmVyYXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gV2UgcmUtY2hlY2sgdGhlIGdlbmVyYXRpb24gaW4gY2FzZSB3ZSd2ZSBoYWQgYW4gZXhwbGljaXRcbiAgICAgICAgICAgICAgICAgICAgLy8gX3BvbGxRdWVyeSBjYWxsIChlZywgaW4gYW5vdGhlciBmaWJlcikgd2hpY2ggc2hvdWxkXG4gICAgICAgICAgICAgICAgICAgIC8vIGVmZmVjdGl2ZWx5IGNhbmNlbCB0aGlzIHJvdW5kIG9mIGZldGNoZXMuICAoX3BvbGxRdWVyeVxuICAgICAgICAgICAgICAgICAgICAvLyBpbmNyZW1lbnRzIHRoZSBnZW5lcmF0aW9uLilcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5faGFuZGxlRG9jKGlkLCBkb2MpO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgICB3YWl0aW5nLS07XG4gICAgICAgICAgICAgICAgICAvLyBCZWNhdXNlIGZldGNoKCkgbmV2ZXIgY2FsbHMgaXRzIGNhbGxiYWNrIHN5bmNocm9ub3VzbHksXG4gICAgICAgICAgICAgICAgICAvLyB0aGlzIGlzIHNhZmUgKGllLCB3ZSB3b24ndCBjYWxsIGZ1dC5yZXR1cm4oKSBiZWZvcmUgdGhlXG4gICAgICAgICAgICAgICAgICAvLyBmb3JFYWNoIGlzIGRvbmUpLlxuICAgICAgICAgICAgICAgICAgaWYgKHdhaXRpbmcgPT09IDApXG4gICAgICAgICAgICAgICAgICAgIGZ1dC5yZXR1cm4oKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBmdXQud2FpdCgpO1xuICAgICAgICAgIC8vIEV4aXQgbm93IGlmIHdlJ3ZlIGhhZCBhIF9wb2xsUXVlcnkgY2FsbCAoaGVyZSBvciBpbiBhbm90aGVyIGZpYmVyKS5cbiAgICAgICAgICBpZiAoc2VsZi5fcGhhc2UgPT09IFBIQVNFLlFVRVJZSU5HKVxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIHNlbGYuX2N1cnJlbnRseUZldGNoaW5nID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgICAvLyBXZSdyZSBkb25lIGZldGNoaW5nLCBzbyB3ZSBjYW4gYmUgc3RlYWR5LCB1bmxlc3Mgd2UndmUgaGFkIGFcbiAgICAgICAgLy8gX3BvbGxRdWVyeSBjYWxsIChoZXJlIG9yIGluIGFub3RoZXIgZmliZXIpLlxuICAgICAgICBpZiAoc2VsZi5fcGhhc2UgIT09IFBIQVNFLlFVRVJZSU5HKVxuICAgICAgICAgIHNlbGYuX2JlU3RlYWR5KCk7XG4gICAgICB9KSk7XG4gICAgfSk7XG4gIH0sXG4gIF9iZVN0ZWFkeTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9yZWdpc3RlclBoYXNlQ2hhbmdlKFBIQVNFLlNURUFEWSk7XG4gICAgICB2YXIgd3JpdGVzID0gc2VsZi5fd3JpdGVzVG9Db21taXRXaGVuV2VSZWFjaFN0ZWFkeTtcbiAgICAgIHNlbGYuX3dyaXRlc1RvQ29tbWl0V2hlbldlUmVhY2hTdGVhZHkgPSBbXTtcbiAgICAgIHNlbGYuX211bHRpcGxleGVyLm9uRmx1c2goZnVuY3Rpb24gKCkge1xuICAgICAgICBfLmVhY2god3JpdGVzLCBmdW5jdGlvbiAodykge1xuICAgICAgICAgIHcuY29tbWl0dGVkKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH0sXG4gIF9oYW5kbGVPcGxvZ0VudHJ5UXVlcnlpbmc6IGZ1bmN0aW9uIChvcCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9uZWVkVG9GZXRjaC5zZXQoaWRGb3JPcChvcCksIG9wKTtcbiAgICB9KTtcbiAgfSxcbiAgX2hhbmRsZU9wbG9nRW50cnlTdGVhZHlPckZldGNoaW5nOiBmdW5jdGlvbiAob3ApIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIGlkID0gaWRGb3JPcChvcCk7XG4gICAgICAvLyBJZiB3ZSdyZSBhbHJlYWR5IGZldGNoaW5nIHRoaXMgb25lLCBvciBhYm91dCB0bywgd2UgY2FuJ3Qgb3B0aW1pemU7XG4gICAgICAvLyBtYWtlIHN1cmUgdGhhdCB3ZSBmZXRjaCBpdCBhZ2FpbiBpZiBuZWNlc3NhcnkuXG4gICAgICBpZiAoc2VsZi5fcGhhc2UgPT09IFBIQVNFLkZFVENISU5HICYmXG4gICAgICAgICAgKChzZWxmLl9jdXJyZW50bHlGZXRjaGluZyAmJiBzZWxmLl9jdXJyZW50bHlGZXRjaGluZy5oYXMoaWQpKSB8fFxuICAgICAgICAgICBzZWxmLl9uZWVkVG9GZXRjaC5oYXMoaWQpKSkge1xuICAgICAgICBzZWxmLl9uZWVkVG9GZXRjaC5zZXQoaWQsIG9wKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAob3Aub3AgPT09ICdkJykge1xuICAgICAgICBpZiAoc2VsZi5fcHVibGlzaGVkLmhhcyhpZCkgfHxcbiAgICAgICAgICAgIChzZWxmLl9saW1pdCAmJiBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5oYXMoaWQpKSlcbiAgICAgICAgICBzZWxmLl9yZW1vdmVNYXRjaGluZyhpZCk7XG4gICAgICB9IGVsc2UgaWYgKG9wLm9wID09PSAnaScpIHtcbiAgICAgICAgaWYgKHNlbGYuX3B1Ymxpc2hlZC5oYXMoaWQpKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcImluc2VydCBmb3VuZCBmb3IgYWxyZWFkeS1leGlzdGluZyBJRCBpbiBwdWJsaXNoZWRcIik7XG4gICAgICAgIGlmIChzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlciAmJiBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5oYXMoaWQpKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcImluc2VydCBmb3VuZCBmb3IgYWxyZWFkeS1leGlzdGluZyBJRCBpbiBidWZmZXJcIik7XG5cbiAgICAgICAgLy8gWFhYIHdoYXQgaWYgc2VsZWN0b3IgeWllbGRzPyAgZm9yIG5vdyBpdCBjYW4ndCBidXQgbGF0ZXIgaXQgY291bGRcbiAgICAgICAgLy8gaGF2ZSAkd2hlcmVcbiAgICAgICAgaWYgKHNlbGYuX21hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKG9wLm8pLnJlc3VsdClcbiAgICAgICAgICBzZWxmLl9hZGRNYXRjaGluZyhvcC5vKTtcbiAgICAgIH0gZWxzZSBpZiAob3Aub3AgPT09ICd1Jykge1xuICAgICAgICAvLyBJcyB0aGlzIGEgbW9kaWZpZXIgKCRzZXQvJHVuc2V0LCB3aGljaCBtYXkgcmVxdWlyZSB1cyB0byBwb2xsIHRoZVxuICAgICAgICAvLyBkYXRhYmFzZSB0byBmaWd1cmUgb3V0IGlmIHRoZSB3aG9sZSBkb2N1bWVudCBtYXRjaGVzIHRoZSBzZWxlY3Rvcikgb3JcbiAgICAgICAgLy8gYSByZXBsYWNlbWVudCAoaW4gd2hpY2ggY2FzZSB3ZSBjYW4ganVzdCBkaXJlY3RseSByZS1ldmFsdWF0ZSB0aGVcbiAgICAgICAgLy8gc2VsZWN0b3IpP1xuICAgICAgICB2YXIgaXNSZXBsYWNlID0gIV8uaGFzKG9wLm8sICckc2V0JykgJiYgIV8uaGFzKG9wLm8sICckdW5zZXQnKTtcbiAgICAgICAgLy8gSWYgdGhpcyBtb2RpZmllciBtb2RpZmllcyBzb21ldGhpbmcgaW5zaWRlIGFuIEVKU09OIGN1c3RvbSB0eXBlIChpZSxcbiAgICAgICAgLy8gYW55dGhpbmcgd2l0aCBFSlNPTiQpLCB0aGVuIHdlIGNhbid0IHRyeSB0byB1c2VcbiAgICAgICAgLy8gTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnksIHNpbmNlIHRoYXQganVzdCBtdXRhdGVzIHRoZSBFSlNPTiBlbmNvZGluZyxcbiAgICAgICAgLy8gbm90IHRoZSBhY3R1YWwgb2JqZWN0LlxuICAgICAgICB2YXIgY2FuRGlyZWN0bHlNb2RpZnlEb2MgPVxuICAgICAgICAgICFpc1JlcGxhY2UgJiYgbW9kaWZpZXJDYW5CZURpcmVjdGx5QXBwbGllZChvcC5vKTtcblxuICAgICAgICB2YXIgcHVibGlzaGVkQmVmb3JlID0gc2VsZi5fcHVibGlzaGVkLmhhcyhpZCk7XG4gICAgICAgIHZhciBidWZmZXJlZEJlZm9yZSA9IHNlbGYuX2xpbWl0ICYmIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmhhcyhpZCk7XG5cbiAgICAgICAgaWYgKGlzUmVwbGFjZSkge1xuICAgICAgICAgIHNlbGYuX2hhbmRsZURvYyhpZCwgXy5leHRlbmQoe19pZDogaWR9LCBvcC5vKSk7XG4gICAgICAgIH0gZWxzZSBpZiAoKHB1Ymxpc2hlZEJlZm9yZSB8fCBidWZmZXJlZEJlZm9yZSkgJiZcbiAgICAgICAgICAgICAgICAgICBjYW5EaXJlY3RseU1vZGlmeURvYykge1xuICAgICAgICAgIC8vIE9oIGdyZWF0LCB3ZSBhY3R1YWxseSBrbm93IHdoYXQgdGhlIGRvY3VtZW50IGlzLCBzbyB3ZSBjYW4gYXBwbHlcbiAgICAgICAgICAvLyB0aGlzIGRpcmVjdGx5LlxuICAgICAgICAgIHZhciBuZXdEb2MgPSBzZWxmLl9wdWJsaXNoZWQuaGFzKGlkKVxuICAgICAgICAgICAgPyBzZWxmLl9wdWJsaXNoZWQuZ2V0KGlkKSA6IHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmdldChpZCk7XG4gICAgICAgICAgbmV3RG9jID0gRUpTT04uY2xvbmUobmV3RG9jKTtcblxuICAgICAgICAgIG5ld0RvYy5faWQgPSBpZDtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnkobmV3RG9jLCBvcC5vKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBpZiAoZS5uYW1lICE9PSBcIk1pbmltb25nb0Vycm9yXCIpXG4gICAgICAgICAgICAgIHRocm93IGU7XG4gICAgICAgICAgICAvLyBXZSBkaWRuJ3QgdW5kZXJzdGFuZCB0aGUgbW9kaWZpZXIuICBSZS1mZXRjaC5cbiAgICAgICAgICAgIHNlbGYuX25lZWRUb0ZldGNoLnNldChpZCwgb3ApO1xuICAgICAgICAgICAgaWYgKHNlbGYuX3BoYXNlID09PSBQSEFTRS5TVEVBRFkpIHtcbiAgICAgICAgICAgICAgc2VsZi5fZmV0Y2hNb2RpZmllZERvY3VtZW50cygpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBzZWxmLl9oYW5kbGVEb2MoaWQsIHNlbGYuX3NoYXJlZFByb2plY3Rpb25GbihuZXdEb2MpKTtcbiAgICAgICAgfSBlbHNlIGlmICghY2FuRGlyZWN0bHlNb2RpZnlEb2MgfHxcbiAgICAgICAgICAgICAgICAgICBzZWxmLl9tYXRjaGVyLmNhbkJlY29tZVRydWVCeU1vZGlmaWVyKG9wLm8pIHx8XG4gICAgICAgICAgICAgICAgICAgKHNlbGYuX3NvcnRlciAmJiBzZWxmLl9zb3J0ZXIuYWZmZWN0ZWRCeU1vZGlmaWVyKG9wLm8pKSkge1xuICAgICAgICAgIHNlbGYuX25lZWRUb0ZldGNoLnNldChpZCwgb3ApO1xuICAgICAgICAgIGlmIChzZWxmLl9waGFzZSA9PT0gUEhBU0UuU1RFQURZKVxuICAgICAgICAgICAgc2VsZi5fZmV0Y2hNb2RpZmllZERvY3VtZW50cygpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBFcnJvcihcIlhYWCBTVVJQUklTSU5HIE9QRVJBVElPTjogXCIgKyBvcCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG4gIC8vIFlpZWxkcyFcbiAgX3J1bkluaXRpYWxRdWVyeTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIm9wbG9nIHN0b3BwZWQgc3VycHJpc2luZ2x5IGVhcmx5XCIpO1xuXG4gICAgc2VsZi5fcnVuUXVlcnkoe2luaXRpYWw6IHRydWV9KTsgIC8vIHlpZWxkc1xuXG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICByZXR1cm47ICAvLyBjYW4gaGFwcGVuIG9uIHF1ZXJ5RXJyb3JcblxuICAgIC8vIEFsbG93IG9ic2VydmVDaGFuZ2VzIGNhbGxzIHRvIHJldHVybi4gKEFmdGVyIHRoaXMsIGl0J3MgcG9zc2libGUgZm9yXG4gICAgLy8gc3RvcCgpIHRvIGJlIGNhbGxlZC4pXG4gICAgc2VsZi5fbXVsdGlwbGV4ZXIucmVhZHkoKTtcblxuICAgIHNlbGYuX2RvbmVRdWVyeWluZygpOyAgLy8geWllbGRzXG4gIH0sXG5cbiAgLy8gSW4gdmFyaW91cyBjaXJjdW1zdGFuY2VzLCB3ZSBtYXkganVzdCB3YW50IHRvIHN0b3AgcHJvY2Vzc2luZyB0aGUgb3Bsb2cgYW5kXG4gIC8vIHJlLXJ1biB0aGUgaW5pdGlhbCBxdWVyeSwganVzdCBhcyBpZiB3ZSB3ZXJlIGEgUG9sbGluZ09ic2VydmVEcml2ZXIuXG4gIC8vXG4gIC8vIFRoaXMgZnVuY3Rpb24gbWF5IG5vdCBibG9jaywgYmVjYXVzZSBpdCBpcyBjYWxsZWQgZnJvbSBhbiBvcGxvZyBlbnRyeVxuICAvLyBoYW5kbGVyLlxuICAvL1xuICAvLyBYWFggV2Ugc2hvdWxkIGNhbGwgdGhpcyB3aGVuIHdlIGRldGVjdCB0aGF0IHdlJ3ZlIGJlZW4gaW4gRkVUQ0hJTkcgZm9yIFwidG9vXG4gIC8vIGxvbmdcIi5cbiAgLy9cbiAgLy8gWFhYIFdlIHNob3VsZCBjYWxsIHRoaXMgd2hlbiB3ZSBkZXRlY3QgTW9uZ28gZmFpbG92ZXIgKHNpbmNlIHRoYXQgbWlnaHRcbiAgLy8gbWVhbiB0aGF0IHNvbWUgb2YgdGhlIG9wbG9nIGVudHJpZXMgd2UgaGF2ZSBwcm9jZXNzZWQgaGF2ZSBiZWVuIHJvbGxlZFxuICAvLyBiYWNrKS4gVGhlIE5vZGUgTW9uZ28gZHJpdmVyIGlzIGluIHRoZSBtaWRkbGUgb2YgYSBidW5jaCBvZiBodWdlXG4gIC8vIHJlZmFjdG9yaW5ncywgaW5jbHVkaW5nIHRoZSB3YXkgdGhhdCBpdCBub3RpZmllcyB5b3Ugd2hlbiBwcmltYXJ5XG4gIC8vIGNoYW5nZXMuIFdpbGwgcHV0IG9mZiBpbXBsZW1lbnRpbmcgdGhpcyB1bnRpbCBkcml2ZXIgMS40IGlzIG91dC5cbiAgX3BvbGxRdWVyeTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICAvLyBZYXksIHdlIGdldCB0byBmb3JnZXQgYWJvdXQgYWxsIHRoZSB0aGluZ3Mgd2UgdGhvdWdodCB3ZSBoYWQgdG8gZmV0Y2guXG4gICAgICBzZWxmLl9uZWVkVG9GZXRjaCA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgICAgc2VsZi5fY3VycmVudGx5RmV0Y2hpbmcgPSBudWxsO1xuICAgICAgKytzZWxmLl9mZXRjaEdlbmVyYXRpb247ICAvLyBpZ25vcmUgYW55IGluLWZsaWdodCBmZXRjaGVzXG4gICAgICBzZWxmLl9yZWdpc3RlclBoYXNlQ2hhbmdlKFBIQVNFLlFVRVJZSU5HKTtcblxuICAgICAgLy8gRGVmZXIgc28gdGhhdCB3ZSBkb24ndCB5aWVsZC4gIFdlIGRvbid0IG5lZWQgZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnlcbiAgICAgIC8vIGhlcmUgYmVjYXVzZSBTd2l0Y2hlZFRvUXVlcnkgaXMgbm90IHRocm93biBpbiBRVUVSWUlORyBtb2RlLlxuICAgICAgTWV0ZW9yLmRlZmVyKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgc2VsZi5fcnVuUXVlcnkoKTtcbiAgICAgICAgc2VsZi5fZG9uZVF1ZXJ5aW5nKCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvLyBZaWVsZHMhXG4gIF9ydW5RdWVyeTogZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgdmFyIG5ld1Jlc3VsdHMsIG5ld0J1ZmZlcjtcblxuICAgIC8vIFRoaXMgd2hpbGUgbG9vcCBpcyBqdXN0IHRvIHJldHJ5IGZhaWx1cmVzLlxuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICAvLyBJZiB3ZSd2ZSBiZWVuIHN0b3BwZWQsIHdlIGRvbid0IGhhdmUgdG8gcnVuIGFueXRoaW5nIGFueSBtb3JlLlxuICAgICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICAgIHJldHVybjtcblxuICAgICAgbmV3UmVzdWx0cyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgICAgbmV3QnVmZmVyID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG5cbiAgICAgIC8vIFF1ZXJ5IDJ4IGRvY3VtZW50cyBhcyB0aGUgaGFsZiBleGNsdWRlZCBmcm9tIHRoZSBvcmlnaW5hbCBxdWVyeSB3aWxsIGdvXG4gICAgICAvLyBpbnRvIHVucHVibGlzaGVkIGJ1ZmZlciB0byByZWR1Y2UgYWRkaXRpb25hbCBNb25nbyBsb29rdXBzIGluIGNhc2VzXG4gICAgICAvLyB3aGVuIGRvY3VtZW50cyBhcmUgcmVtb3ZlZCBmcm9tIHRoZSBwdWJsaXNoZWQgc2V0IGFuZCBuZWVkIGFcbiAgICAgIC8vIHJlcGxhY2VtZW50LlxuICAgICAgLy8gWFhYIG5lZWRzIG1vcmUgdGhvdWdodCBvbiBub24temVybyBza2lwXG4gICAgICAvLyBYWFggMiBpcyBhIFwibWFnaWMgbnVtYmVyXCIgbWVhbmluZyB0aGVyZSBpcyBhbiBleHRyYSBjaHVuayBvZiBkb2NzIGZvclxuICAgICAgLy8gYnVmZmVyIGlmIHN1Y2ggaXMgbmVlZGVkLlxuICAgICAgdmFyIGN1cnNvciA9IHNlbGYuX2N1cnNvckZvclF1ZXJ5KHsgbGltaXQ6IHNlbGYuX2xpbWl0ICogMiB9KTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGN1cnNvci5mb3JFYWNoKGZ1bmN0aW9uIChkb2MsIGkpIHsgIC8vIHlpZWxkc1xuICAgICAgICAgIGlmICghc2VsZi5fbGltaXQgfHwgaSA8IHNlbGYuX2xpbWl0KSB7XG4gICAgICAgICAgICBuZXdSZXN1bHRzLnNldChkb2MuX2lkLCBkb2MpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBuZXdCdWZmZXIuc2V0KGRvYy5faWQsIGRvYyk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmIChvcHRpb25zLmluaXRpYWwgJiYgdHlwZW9mKGUuY29kZSkgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgLy8gVGhpcyBpcyBhbiBlcnJvciBkb2N1bWVudCBzZW50IHRvIHVzIGJ5IG1vbmdvZCwgbm90IGEgY29ubmVjdGlvblxuICAgICAgICAgIC8vIGVycm9yIGdlbmVyYXRlZCBieSB0aGUgY2xpZW50LiBBbmQgd2UndmUgbmV2ZXIgc2VlbiB0aGlzIHF1ZXJ5IHdvcmtcbiAgICAgICAgICAvLyBzdWNjZXNzZnVsbHkuIFByb2JhYmx5IGl0J3MgYSBiYWQgc2VsZWN0b3Igb3Igc29tZXRoaW5nLCBzbyB3ZVxuICAgICAgICAgIC8vIHNob3VsZCBOT1QgcmV0cnkuIEluc3RlYWQsIHdlIHNob3VsZCBoYWx0IHRoZSBvYnNlcnZlICh3aGljaCBlbmRzXG4gICAgICAgICAgLy8gdXAgY2FsbGluZyBgc3RvcGAgb24gdXMpLlxuICAgICAgICAgIHNlbGYuX211bHRpcGxleGVyLnF1ZXJ5RXJyb3IoZSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRHVyaW5nIGZhaWxvdmVyIChlZykgaWYgd2UgZ2V0IGFuIGV4Y2VwdGlvbiB3ZSBzaG91bGQgbG9nIGFuZCByZXRyeVxuICAgICAgICAvLyBpbnN0ZWFkIG9mIGNyYXNoaW5nLlxuICAgICAgICBNZXRlb3IuX2RlYnVnKFwiR290IGV4Y2VwdGlvbiB3aGlsZSBwb2xsaW5nIHF1ZXJ5XCIsIGUpO1xuICAgICAgICBNZXRlb3IuX3NsZWVwRm9yTXMoMTAwKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgIHJldHVybjtcblxuICAgIHNlbGYuX3B1Ymxpc2hOZXdSZXN1bHRzKG5ld1Jlc3VsdHMsIG5ld0J1ZmZlcik7XG4gIH0sXG5cbiAgLy8gVHJhbnNpdGlvbnMgdG8gUVVFUllJTkcgYW5kIHJ1bnMgYW5vdGhlciBxdWVyeSwgb3IgKGlmIGFscmVhZHkgaW4gUVVFUllJTkcpXG4gIC8vIGVuc3VyZXMgdGhhdCB3ZSB3aWxsIHF1ZXJ5IGFnYWluIGxhdGVyLlxuICAvL1xuICAvLyBUaGlzIGZ1bmN0aW9uIG1heSBub3QgYmxvY2ssIGJlY2F1c2UgaXQgaXMgY2FsbGVkIGZyb20gYW4gb3Bsb2cgZW50cnlcbiAgLy8gaGFuZGxlci4gSG93ZXZlciwgaWYgd2Ugd2VyZSBub3QgYWxyZWFkeSBpbiB0aGUgUVVFUllJTkcgcGhhc2UsIGl0IHRocm93c1xuICAvLyBhbiBleGNlcHRpb24gdGhhdCBpcyBjYXVnaHQgYnkgdGhlIGNsb3Nlc3Qgc3Vycm91bmRpbmdcbiAgLy8gZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnkgY2FsbDsgdGhpcyBlbnN1cmVzIHRoYXQgd2UgZG9uJ3QgY29udGludWUgcnVubmluZ1xuICAvLyBjbG9zZSB0aGF0IHdhcyBkZXNpZ25lZCBmb3IgYW5vdGhlciBwaGFzZSBpbnNpZGUgUEhBU0UuUVVFUllJTkcuXG4gIC8vXG4gIC8vIChJdCdzIGFsc28gbmVjZXNzYXJ5IHdoZW5ldmVyIGxvZ2ljIGluIHRoaXMgZmlsZSB5aWVsZHMgdG8gY2hlY2sgdGhhdCBvdGhlclxuICAvLyBwaGFzZXMgaGF2ZW4ndCBwdXQgdXMgaW50byBRVUVSWUlORyBtb2RlLCB0aG91Z2g7IGVnLFxuICAvLyBfZmV0Y2hNb2RpZmllZERvY3VtZW50cyBkb2VzIHRoaXMuKVxuICBfbmVlZFRvUG9sbFF1ZXJ5OiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIC8vIElmIHdlJ3JlIG5vdCBhbHJlYWR5IGluIHRoZSBtaWRkbGUgb2YgYSBxdWVyeSwgd2UgY2FuIHF1ZXJ5IG5vd1xuICAgICAgLy8gKHBvc3NpYmx5IHBhdXNpbmcgRkVUQ0hJTkcpLlxuICAgICAgaWYgKHNlbGYuX3BoYXNlICE9PSBQSEFTRS5RVUVSWUlORykge1xuICAgICAgICBzZWxmLl9wb2xsUXVlcnkoKTtcbiAgICAgICAgdGhyb3cgbmV3IFN3aXRjaGVkVG9RdWVyeTtcbiAgICAgIH1cblxuICAgICAgLy8gV2UncmUgY3VycmVudGx5IGluIFFVRVJZSU5HLiBTZXQgYSBmbGFnIHRvIGVuc3VyZSB0aGF0IHdlIHJ1biBhbm90aGVyXG4gICAgICAvLyBxdWVyeSB3aGVuIHdlJ3JlIGRvbmUuXG4gICAgICBzZWxmLl9yZXF1ZXJ5V2hlbkRvbmVUaGlzUXVlcnkgPSB0cnVlO1xuICAgIH0pO1xuICB9LFxuXG4gIC8vIFlpZWxkcyFcbiAgX2RvbmVRdWVyeWluZzogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgcmV0dXJuO1xuICAgIHNlbGYuX21vbmdvSGFuZGxlLl9vcGxvZ0hhbmRsZS53YWl0VW50aWxDYXVnaHRVcCgpOyAgLy8geWllbGRzXG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICByZXR1cm47XG4gICAgaWYgKHNlbGYuX3BoYXNlICE9PSBQSEFTRS5RVUVSWUlORylcbiAgICAgIHRocm93IEVycm9yKFwiUGhhc2UgdW5leHBlY3RlZGx5IFwiICsgc2VsZi5fcGhhc2UpO1xuXG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHNlbGYuX3JlcXVlcnlXaGVuRG9uZVRoaXNRdWVyeSkge1xuICAgICAgICBzZWxmLl9yZXF1ZXJ5V2hlbkRvbmVUaGlzUXVlcnkgPSBmYWxzZTtcbiAgICAgICAgc2VsZi5fcG9sbFF1ZXJ5KCk7XG4gICAgICB9IGVsc2UgaWYgKHNlbGYuX25lZWRUb0ZldGNoLmVtcHR5KCkpIHtcbiAgICAgICAgc2VsZi5fYmVTdGVhZHkoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNlbGYuX2ZldGNoTW9kaWZpZWREb2N1bWVudHMoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcblxuICBfY3Vyc29yRm9yUXVlcnk6IGZ1bmN0aW9uIChvcHRpb25zT3ZlcndyaXRlKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICAvLyBUaGUgcXVlcnkgd2UgcnVuIGlzIGFsbW9zdCB0aGUgc2FtZSBhcyB0aGUgY3Vyc29yIHdlIGFyZSBvYnNlcnZpbmcsXG4gICAgICAvLyB3aXRoIGEgZmV3IGNoYW5nZXMuIFdlIG5lZWQgdG8gcmVhZCBhbGwgdGhlIGZpZWxkcyB0aGF0IGFyZSByZWxldmFudCB0b1xuICAgICAgLy8gdGhlIHNlbGVjdG9yLCBub3QganVzdCB0aGUgZmllbGRzIHdlIGFyZSBnb2luZyB0byBwdWJsaXNoICh0aGF0J3MgdGhlXG4gICAgICAvLyBcInNoYXJlZFwiIHByb2plY3Rpb24pLiBBbmQgd2UgZG9uJ3Qgd2FudCB0byBhcHBseSBhbnkgdHJhbnNmb3JtIGluIHRoZVxuICAgICAgLy8gY3Vyc29yLCBiZWNhdXNlIG9ic2VydmVDaGFuZ2VzIHNob3VsZG4ndCB1c2UgdGhlIHRyYW5zZm9ybS5cbiAgICAgIHZhciBvcHRpb25zID0gXy5jbG9uZShzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zKTtcblxuICAgICAgLy8gQWxsb3cgdGhlIGNhbGxlciB0byBtb2RpZnkgdGhlIG9wdGlvbnMuIFVzZWZ1bCB0byBzcGVjaWZ5IGRpZmZlcmVudFxuICAgICAgLy8gc2tpcCBhbmQgbGltaXQgdmFsdWVzLlxuICAgICAgXy5leHRlbmQob3B0aW9ucywgb3B0aW9uc092ZXJ3cml0ZSk7XG5cbiAgICAgIG9wdGlvbnMuZmllbGRzID0gc2VsZi5fc2hhcmVkUHJvamVjdGlvbjtcbiAgICAgIGRlbGV0ZSBvcHRpb25zLnRyYW5zZm9ybTtcbiAgICAgIC8vIFdlIGFyZSBOT1QgZGVlcCBjbG9uaW5nIGZpZWxkcyBvciBzZWxlY3RvciBoZXJlLCB3aGljaCBzaG91bGQgYmUgT0suXG4gICAgICB2YXIgZGVzY3JpcHRpb24gPSBuZXcgQ3Vyc29yRGVzY3JpcHRpb24oXG4gICAgICAgIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLmNvbGxlY3Rpb25OYW1lLFxuICAgICAgICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5zZWxlY3RvcixcbiAgICAgICAgb3B0aW9ucyk7XG4gICAgICByZXR1cm4gbmV3IEN1cnNvcihzZWxmLl9tb25nb0hhbmRsZSwgZGVzY3JpcHRpb24pO1xuICAgIH0pO1xuICB9LFxuXG5cbiAgLy8gUmVwbGFjZSBzZWxmLl9wdWJsaXNoZWQgd2l0aCBuZXdSZXN1bHRzIChib3RoIGFyZSBJZE1hcHMpLCBpbnZva2luZyBvYnNlcnZlXG4gIC8vIGNhbGxiYWNrcyBvbiB0aGUgbXVsdGlwbGV4ZXIuXG4gIC8vIFJlcGxhY2Ugc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIgd2l0aCBuZXdCdWZmZXIuXG4gIC8vXG4gIC8vIFhYWCBUaGlzIGlzIHZlcnkgc2ltaWxhciB0byBMb2NhbENvbGxlY3Rpb24uX2RpZmZRdWVyeVVub3JkZXJlZENoYW5nZXMuIFdlXG4gIC8vIHNob3VsZCByZWFsbHk6IChhKSBVbmlmeSBJZE1hcCBhbmQgT3JkZXJlZERpY3QgaW50byBVbm9yZGVyZWQvT3JkZXJlZERpY3RcbiAgLy8gKGIpIFJld3JpdGUgZGlmZi5qcyB0byB1c2UgdGhlc2UgY2xhc3NlcyBpbnN0ZWFkIG9mIGFycmF5cyBhbmQgb2JqZWN0cy5cbiAgX3B1Ymxpc2hOZXdSZXN1bHRzOiBmdW5jdGlvbiAobmV3UmVzdWx0cywgbmV3QnVmZmVyKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcblxuICAgICAgLy8gSWYgdGhlIHF1ZXJ5IGlzIGxpbWl0ZWQgYW5kIHRoZXJlIGlzIGEgYnVmZmVyLCBzaHV0IGRvd24gc28gaXQgZG9lc24ndFxuICAgICAgLy8gc3RheSBpbiBhIHdheS5cbiAgICAgIGlmIChzZWxmLl9saW1pdCkge1xuICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5jbGVhcigpO1xuICAgICAgfVxuXG4gICAgICAvLyBGaXJzdCByZW1vdmUgYW55dGhpbmcgdGhhdCdzIGdvbmUuIEJlIGNhcmVmdWwgbm90IHRvIG1vZGlmeVxuICAgICAgLy8gc2VsZi5fcHVibGlzaGVkIHdoaWxlIGl0ZXJhdGluZyBvdmVyIGl0LlxuICAgICAgdmFyIGlkc1RvUmVtb3ZlID0gW107XG4gICAgICBzZWxmLl9wdWJsaXNoZWQuZm9yRWFjaChmdW5jdGlvbiAoZG9jLCBpZCkge1xuICAgICAgICBpZiAoIW5ld1Jlc3VsdHMuaGFzKGlkKSlcbiAgICAgICAgICBpZHNUb1JlbW92ZS5wdXNoKGlkKTtcbiAgICAgIH0pO1xuICAgICAgXy5lYWNoKGlkc1RvUmVtb3ZlLCBmdW5jdGlvbiAoaWQpIHtcbiAgICAgICAgc2VsZi5fcmVtb3ZlUHVibGlzaGVkKGlkKTtcbiAgICAgIH0pO1xuXG4gICAgICAvLyBOb3cgZG8gYWRkcyBhbmQgY2hhbmdlcy5cbiAgICAgIC8vIElmIHNlbGYgaGFzIGEgYnVmZmVyIGFuZCBsaW1pdCwgdGhlIG5ldyBmZXRjaGVkIHJlc3VsdCB3aWxsIGJlXG4gICAgICAvLyBsaW1pdGVkIGNvcnJlY3RseSBhcyB0aGUgcXVlcnkgaGFzIHNvcnQgc3BlY2lmaWVyLlxuICAgICAgbmV3UmVzdWx0cy5mb3JFYWNoKGZ1bmN0aW9uIChkb2MsIGlkKSB7XG4gICAgICAgIHNlbGYuX2hhbmRsZURvYyhpZCwgZG9jKTtcbiAgICAgIH0pO1xuXG4gICAgICAvLyBTYW5pdHktY2hlY2sgdGhhdCBldmVyeXRoaW5nIHdlIHRyaWVkIHRvIHB1dCBpbnRvIF9wdWJsaXNoZWQgZW5kZWQgdXBcbiAgICAgIC8vIHRoZXJlLlxuICAgICAgLy8gWFhYIGlmIHRoaXMgaXMgc2xvdywgcmVtb3ZlIGl0IGxhdGVyXG4gICAgICBpZiAoc2VsZi5fcHVibGlzaGVkLnNpemUoKSAhPT0gbmV3UmVzdWx0cy5zaXplKCkpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcignVGhlIE1vbmdvIHNlcnZlciBhbmQgdGhlIE1ldGVvciBxdWVyeSBkaXNhZ3JlZSBvbiBob3cgJyArXG4gICAgICAgICAgJ21hbnkgZG9jdW1lbnRzIG1hdGNoIHlvdXIgcXVlcnkuIEN1cnNvciBkZXNjcmlwdGlvbjogJyxcbiAgICAgICAgICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbik7XG4gICAgICAgIHRocm93IEVycm9yKFxuICAgICAgICAgIFwiVGhlIE1vbmdvIHNlcnZlciBhbmQgdGhlIE1ldGVvciBxdWVyeSBkaXNhZ3JlZSBvbiBob3cgXCIgK1xuICAgICAgICAgICAgXCJtYW55IGRvY3VtZW50cyBtYXRjaCB5b3VyIHF1ZXJ5LiBNYXliZSBpdCBpcyBoaXR0aW5nIGEgTW9uZ28gXCIgK1xuICAgICAgICAgICAgXCJlZGdlIGNhc2U/IFRoZSBxdWVyeSBpczogXCIgK1xuICAgICAgICAgICAgRUpTT04uc3RyaW5naWZ5KHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLnNlbGVjdG9yKSk7XG4gICAgICB9XG4gICAgICBzZWxmLl9wdWJsaXNoZWQuZm9yRWFjaChmdW5jdGlvbiAoZG9jLCBpZCkge1xuICAgICAgICBpZiAoIW5ld1Jlc3VsdHMuaGFzKGlkKSlcbiAgICAgICAgICB0aHJvdyBFcnJvcihcIl9wdWJsaXNoZWQgaGFzIGEgZG9jIHRoYXQgbmV3UmVzdWx0cyBkb2Vzbid0OyBcIiArIGlkKTtcbiAgICAgIH0pO1xuXG4gICAgICAvLyBGaW5hbGx5LCByZXBsYWNlIHRoZSBidWZmZXJcbiAgICAgIG5ld0J1ZmZlci5mb3JFYWNoKGZ1bmN0aW9uIChkb2MsIGlkKSB7XG4gICAgICAgIHNlbGYuX2FkZEJ1ZmZlcmVkKGlkLCBkb2MpO1xuICAgICAgfSk7XG5cbiAgICAgIHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlciA9IG5ld0J1ZmZlci5zaXplKCkgPCBzZWxmLl9saW1pdDtcbiAgICB9KTtcbiAgfSxcblxuICAvLyBUaGlzIHN0b3AgZnVuY3Rpb24gaXMgaW52b2tlZCBmcm9tIHRoZSBvblN0b3Agb2YgdGhlIE9ic2VydmVNdWx0aXBsZXhlciwgc29cbiAgLy8gaXQgc2hvdWxkbid0IGFjdHVhbGx5IGJlIHBvc3NpYmxlIHRvIGNhbGwgaXQgdW50aWwgdGhlIG11bHRpcGxleGVyIGlzXG4gIC8vIHJlYWR5LlxuICAvL1xuICAvLyBJdCdzIGltcG9ydGFudCB0byBjaGVjayBzZWxmLl9zdG9wcGVkIGFmdGVyIGV2ZXJ5IGNhbGwgaW4gdGhpcyBmaWxlIHRoYXRcbiAgLy8gY2FuIHlpZWxkIVxuICBzdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgcmV0dXJuO1xuICAgIHNlbGYuX3N0b3BwZWQgPSB0cnVlO1xuICAgIF8uZWFjaChzZWxmLl9zdG9wSGFuZGxlcywgZnVuY3Rpb24gKGhhbmRsZSkge1xuICAgICAgaGFuZGxlLnN0b3AoKTtcbiAgICB9KTtcblxuICAgIC8vIE5vdGU6IHdlICpkb24ndCogdXNlIG11bHRpcGxleGVyLm9uRmx1c2ggaGVyZSBiZWNhdXNlIHRoaXMgc3RvcFxuICAgIC8vIGNhbGxiYWNrIGlzIGFjdHVhbGx5IGludm9rZWQgYnkgdGhlIG11bHRpcGxleGVyIGl0c2VsZiB3aGVuIGl0IGhhc1xuICAgIC8vIGRldGVybWluZWQgdGhhdCB0aGVyZSBhcmUgbm8gaGFuZGxlcyBsZWZ0LiBTbyBub3RoaW5nIGlzIGFjdHVhbGx5IGdvaW5nXG4gICAgLy8gdG8gZ2V0IGZsdXNoZWQgKGFuZCBpdCdzIHByb2JhYmx5IG5vdCB2YWxpZCB0byBjYWxsIG1ldGhvZHMgb24gdGhlXG4gICAgLy8gZHlpbmcgbXVsdGlwbGV4ZXIpLlxuICAgIF8uZWFjaChzZWxmLl93cml0ZXNUb0NvbW1pdFdoZW5XZVJlYWNoU3RlYWR5LCBmdW5jdGlvbiAodykge1xuICAgICAgdy5jb21taXR0ZWQoKTsgIC8vIG1heWJlIHlpZWxkcz9cbiAgICB9KTtcbiAgICBzZWxmLl93cml0ZXNUb0NvbW1pdFdoZW5XZVJlYWNoU3RlYWR5ID0gbnVsbDtcblxuICAgIC8vIFByb2FjdGl2ZWx5IGRyb3AgcmVmZXJlbmNlcyB0byBwb3RlbnRpYWxseSBiaWcgdGhpbmdzLlxuICAgIHNlbGYuX3B1Ymxpc2hlZCA9IG51bGw7XG4gICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIgPSBudWxsO1xuICAgIHNlbGYuX25lZWRUb0ZldGNoID0gbnVsbDtcbiAgICBzZWxmLl9jdXJyZW50bHlGZXRjaGluZyA9IG51bGw7XG4gICAgc2VsZi5fb3Bsb2dFbnRyeUhhbmRsZSA9IG51bGw7XG4gICAgc2VsZi5fbGlzdGVuZXJzSGFuZGxlID0gbnVsbDtcblxuICAgIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSAmJiBQYWNrYWdlWydmYWN0cy1iYXNlJ10uRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLWRyaXZlcnMtb3Bsb2dcIiwgLTEpO1xuICB9LFxuXG4gIF9yZWdpc3RlclBoYXNlQ2hhbmdlOiBmdW5jdGlvbiAocGhhc2UpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIG5vdyA9IG5ldyBEYXRlO1xuXG4gICAgICBpZiAoc2VsZi5fcGhhc2UpIHtcbiAgICAgICAgdmFyIHRpbWVEaWZmID0gbm93IC0gc2VsZi5fcGhhc2VTdGFydFRpbWU7XG4gICAgICAgIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSAmJiBQYWNrYWdlWydmYWN0cy1iYXNlJ10uRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICAgICAgICBcIm1vbmdvLWxpdmVkYXRhXCIsIFwidGltZS1zcGVudC1pbi1cIiArIHNlbGYuX3BoYXNlICsgXCItcGhhc2VcIiwgdGltZURpZmYpO1xuICAgICAgfVxuXG4gICAgICBzZWxmLl9waGFzZSA9IHBoYXNlO1xuICAgICAgc2VsZi5fcGhhc2VTdGFydFRpbWUgPSBub3c7XG4gICAgfSk7XG4gIH1cbn0pO1xuXG4vLyBEb2VzIG91ciBvcGxvZyB0YWlsaW5nIGNvZGUgc3VwcG9ydCB0aGlzIGN1cnNvcj8gRm9yIG5vdywgd2UgYXJlIGJlaW5nIHZlcnlcbi8vIGNvbnNlcnZhdGl2ZSBhbmQgYWxsb3dpbmcgb25seSBzaW1wbGUgcXVlcmllcyB3aXRoIHNpbXBsZSBvcHRpb25zLlxuLy8gKFRoaXMgaXMgYSBcInN0YXRpYyBtZXRob2RcIi4pXG5PcGxvZ09ic2VydmVEcml2ZXIuY3Vyc29yU3VwcG9ydGVkID0gZnVuY3Rpb24gKGN1cnNvckRlc2NyaXB0aW9uLCBtYXRjaGVyKSB7XG4gIC8vIEZpcnN0LCBjaGVjayB0aGUgb3B0aW9ucy5cbiAgdmFyIG9wdGlvbnMgPSBjdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zO1xuXG4gIC8vIERpZCB0aGUgdXNlciBzYXkgbm8gZXhwbGljaXRseT9cbiAgLy8gdW5kZXJzY29yZWQgdmVyc2lvbiBvZiB0aGUgb3B0aW9uIGlzIENPTVBBVCB3aXRoIDEuMlxuICBpZiAob3B0aW9ucy5kaXNhYmxlT3Bsb2cgfHwgb3B0aW9ucy5fZGlzYWJsZU9wbG9nKVxuICAgIHJldHVybiBmYWxzZTtcblxuICAvLyBza2lwIGlzIG5vdCBzdXBwb3J0ZWQ6IHRvIHN1cHBvcnQgaXQgd2Ugd291bGQgbmVlZCB0byBrZWVwIHRyYWNrIG9mIGFsbFxuICAvLyBcInNraXBwZWRcIiBkb2N1bWVudHMgb3IgYXQgbGVhc3QgdGhlaXIgaWRzLlxuICAvLyBsaW1pdCB3L28gYSBzb3J0IHNwZWNpZmllciBpcyBub3Qgc3VwcG9ydGVkOiBjdXJyZW50IGltcGxlbWVudGF0aW9uIG5lZWRzIGFcbiAgLy8gZGV0ZXJtaW5pc3RpYyB3YXkgdG8gb3JkZXIgZG9jdW1lbnRzLlxuICBpZiAob3B0aW9ucy5za2lwIHx8IChvcHRpb25zLmxpbWl0ICYmICFvcHRpb25zLnNvcnQpKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gSWYgYSBmaWVsZHMgcHJvamVjdGlvbiBvcHRpb24gaXMgZ2l2ZW4gY2hlY2sgaWYgaXQgaXMgc3VwcG9ydGVkIGJ5XG4gIC8vIG1pbmltb25nbyAoc29tZSBvcGVyYXRvcnMgYXJlIG5vdCBzdXBwb3J0ZWQpLlxuICBpZiAob3B0aW9ucy5maWVsZHMpIHtcbiAgICB0cnkge1xuICAgICAgTG9jYWxDb2xsZWN0aW9uLl9jaGVja1N1cHBvcnRlZFByb2plY3Rpb24ob3B0aW9ucy5maWVsZHMpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmIChlLm5hbWUgPT09IFwiTWluaW1vbmdvRXJyb3JcIikge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFdlIGRvbid0IGFsbG93IHRoZSBmb2xsb3dpbmcgc2VsZWN0b3JzOlxuICAvLyAgIC0gJHdoZXJlIChub3QgY29uZmlkZW50IHRoYXQgd2UgcHJvdmlkZSB0aGUgc2FtZSBKUyBlbnZpcm9ubWVudFxuICAvLyAgICAgICAgICAgICBhcyBNb25nbywgYW5kIGNhbiB5aWVsZCEpXG4gIC8vICAgLSAkbmVhciAoaGFzIFwiaW50ZXJlc3RpbmdcIiBwcm9wZXJ0aWVzIGluIE1vbmdvREIsIGxpa2UgdGhlIHBvc3NpYmlsaXR5XG4gIC8vICAgICAgICAgICAgb2YgcmV0dXJuaW5nIGFuIElEIG11bHRpcGxlIHRpbWVzLCB0aG91Z2ggZXZlbiBwb2xsaW5nIG1heWJlXG4gIC8vICAgICAgICAgICAgaGF2ZSBhIGJ1ZyB0aGVyZSlcbiAgLy8gICAgICAgICAgIFhYWDogb25jZSB3ZSBzdXBwb3J0IGl0LCB3ZSB3b3VsZCBuZWVkIHRvIHRoaW5rIG1vcmUgb24gaG93IHdlXG4gIC8vICAgICAgICAgICBpbml0aWFsaXplIHRoZSBjb21wYXJhdG9ycyB3aGVuIHdlIGNyZWF0ZSB0aGUgZHJpdmVyLlxuICByZXR1cm4gIW1hdGNoZXIuaGFzV2hlcmUoKSAmJiAhbWF0Y2hlci5oYXNHZW9RdWVyeSgpO1xufTtcblxudmFyIG1vZGlmaWVyQ2FuQmVEaXJlY3RseUFwcGxpZWQgPSBmdW5jdGlvbiAobW9kaWZpZXIpIHtcbiAgcmV0dXJuIF8uYWxsKG1vZGlmaWVyLCBmdW5jdGlvbiAoZmllbGRzLCBvcGVyYXRpb24pIHtcbiAgICByZXR1cm4gXy5hbGwoZmllbGRzLCBmdW5jdGlvbiAodmFsdWUsIGZpZWxkKSB7XG4gICAgICByZXR1cm4gIS9FSlNPTlxcJC8udGVzdChmaWVsZCk7XG4gICAgfSk7XG4gIH0pO1xufTtcblxuTW9uZ29JbnRlcm5hbHMuT3Bsb2dPYnNlcnZlRHJpdmVyID0gT3Bsb2dPYnNlcnZlRHJpdmVyO1xuIiwiLy8gc2luZ2xldG9uXG5leHBvcnQgY29uc3QgTG9jYWxDb2xsZWN0aW9uRHJpdmVyID0gbmV3IChjbGFzcyBMb2NhbENvbGxlY3Rpb25Ecml2ZXIge1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICB0aGlzLm5vQ29ubkNvbGxlY3Rpb25zID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcbiAgfVxuXG4gIG9wZW4obmFtZSwgY29ubikge1xuICAgIGlmICghIG5hbWUpIHtcbiAgICAgIHJldHVybiBuZXcgTG9jYWxDb2xsZWN0aW9uO1xuICAgIH1cblxuICAgIGlmICghIGNvbm4pIHtcbiAgICAgIHJldHVybiBlbnN1cmVDb2xsZWN0aW9uKG5hbWUsIHRoaXMubm9Db25uQ29sbGVjdGlvbnMpO1xuICAgIH1cblxuICAgIGlmICghIGNvbm4uX21vbmdvX2xpdmVkYXRhX2NvbGxlY3Rpb25zKSB7XG4gICAgICBjb25uLl9tb25nb19saXZlZGF0YV9jb2xsZWN0aW9ucyA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG4gICAgfVxuXG4gICAgLy8gWFhYIGlzIHRoZXJlIGEgd2F5IHRvIGtlZXAgdHJhY2sgb2YgYSBjb25uZWN0aW9uJ3MgY29sbGVjdGlvbnMgd2l0aG91dFxuICAgIC8vIGRhbmdsaW5nIGl0IG9mZiB0aGUgY29ubmVjdGlvbiBvYmplY3Q/XG4gICAgcmV0dXJuIGVuc3VyZUNvbGxlY3Rpb24obmFtZSwgY29ubi5fbW9uZ29fbGl2ZWRhdGFfY29sbGVjdGlvbnMpO1xuICB9XG59KTtcblxuZnVuY3Rpb24gZW5zdXJlQ29sbGVjdGlvbihuYW1lLCBjb2xsZWN0aW9ucykge1xuICByZXR1cm4gKG5hbWUgaW4gY29sbGVjdGlvbnMpXG4gICAgPyBjb2xsZWN0aW9uc1tuYW1lXVxuICAgIDogY29sbGVjdGlvbnNbbmFtZV0gPSBuZXcgTG9jYWxDb2xsZWN0aW9uKG5hbWUpO1xufVxuIiwiTW9uZ29JbnRlcm5hbHMuUmVtb3RlQ29sbGVjdGlvbkRyaXZlciA9IGZ1bmN0aW9uIChcbiAgbW9uZ29fdXJsLCBvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgc2VsZi5tb25nbyA9IG5ldyBNb25nb0Nvbm5lY3Rpb24obW9uZ29fdXJsLCBvcHRpb25zKTtcbn07XG5cbl8uZXh0ZW5kKE1vbmdvSW50ZXJuYWxzLlJlbW90ZUNvbGxlY3Rpb25Ecml2ZXIucHJvdG90eXBlLCB7XG4gIG9wZW46IGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciByZXQgPSB7fTtcbiAgICBfLmVhY2goXG4gICAgICBbJ2ZpbmQnLCAnZmluZE9uZScsICdpbnNlcnQnLCAndXBkYXRlJywgJ3Vwc2VydCcsXG4gICAgICAgJ3JlbW92ZScsICdfZW5zdXJlSW5kZXgnLCAnX2Ryb3BJbmRleCcsICdfY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbicsXG4gICAgICAgJ2Ryb3BDb2xsZWN0aW9uJywgJ3Jhd0NvbGxlY3Rpb24nXSxcbiAgICAgIGZ1bmN0aW9uIChtKSB7XG4gICAgICAgIHJldFttXSA9IF8uYmluZChzZWxmLm1vbmdvW21dLCBzZWxmLm1vbmdvLCBuYW1lKTtcbiAgICAgIH0pO1xuICAgIHJldHVybiByZXQ7XG4gIH1cbn0pO1xuXG5cbi8vIENyZWF0ZSB0aGUgc2luZ2xldG9uIFJlbW90ZUNvbGxlY3Rpb25Ecml2ZXIgb25seSBvbiBkZW1hbmQsIHNvIHdlXG4vLyBvbmx5IHJlcXVpcmUgTW9uZ28gY29uZmlndXJhdGlvbiBpZiBpdCdzIGFjdHVhbGx5IHVzZWQgKGVnLCBub3QgaWZcbi8vIHlvdSdyZSBvbmx5IHRyeWluZyB0byByZWNlaXZlIGRhdGEgZnJvbSBhIHJlbW90ZSBERFAgc2VydmVyLilcbk1vbmdvSW50ZXJuYWxzLmRlZmF1bHRSZW1vdGVDb2xsZWN0aW9uRHJpdmVyID0gXy5vbmNlKGZ1bmN0aW9uICgpIHtcbiAgdmFyIGNvbm5lY3Rpb25PcHRpb25zID0ge307XG5cbiAgdmFyIG1vbmdvVXJsID0gcHJvY2Vzcy5lbnYuTU9OR09fVVJMO1xuXG4gIGlmIChwcm9jZXNzLmVudi5NT05HT19PUExPR19VUkwpIHtcbiAgICBjb25uZWN0aW9uT3B0aW9ucy5vcGxvZ1VybCA9IHByb2Nlc3MuZW52Lk1PTkdPX09QTE9HX1VSTDtcbiAgfVxuXG4gIGlmICghIG1vbmdvVXJsKVxuICAgIHRocm93IG5ldyBFcnJvcihcIk1PTkdPX1VSTCBtdXN0IGJlIHNldCBpbiBlbnZpcm9ubWVudFwiKTtcblxuICByZXR1cm4gbmV3IE1vbmdvSW50ZXJuYWxzLlJlbW90ZUNvbGxlY3Rpb25Ecml2ZXIobW9uZ29VcmwsIGNvbm5lY3Rpb25PcHRpb25zKTtcbn0pO1xuIiwiLy8gb3B0aW9ucy5jb25uZWN0aW9uLCBpZiBnaXZlbiwgaXMgYSBMaXZlZGF0YUNsaWVudCBvciBMaXZlZGF0YVNlcnZlclxuLy8gWFhYIHByZXNlbnRseSB0aGVyZSBpcyBubyB3YXkgdG8gZGVzdHJveS9jbGVhbiB1cCBhIENvbGxlY3Rpb25cblxuLyoqXG4gKiBAc3VtbWFyeSBOYW1lc3BhY2UgZm9yIE1vbmdvREItcmVsYXRlZCBpdGVtc1xuICogQG5hbWVzcGFjZVxuICovXG5Nb25nbyA9IHt9O1xuXG4vKipcbiAqIEBzdW1tYXJ5IENvbnN0cnVjdG9yIGZvciBhIENvbGxlY3Rpb25cbiAqIEBsb2N1cyBBbnl3aGVyZVxuICogQGluc3RhbmNlbmFtZSBjb2xsZWN0aW9uXG4gKiBAY2xhc3NcbiAqIEBwYXJhbSB7U3RyaW5nfSBuYW1lIFRoZSBuYW1lIG9mIHRoZSBjb2xsZWN0aW9uLiAgSWYgbnVsbCwgY3JlYXRlcyBhbiB1bm1hbmFnZWQgKHVuc3luY2hyb25pemVkKSBsb2NhbCBjb2xsZWN0aW9uLlxuICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXVxuICogQHBhcmFtIHtPYmplY3R9IG9wdGlvbnMuY29ubmVjdGlvbiBUaGUgc2VydmVyIGNvbm5lY3Rpb24gdGhhdCB3aWxsIG1hbmFnZSB0aGlzIGNvbGxlY3Rpb24uIFVzZXMgdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBpZiBub3Qgc3BlY2lmaWVkLiAgUGFzcyB0aGUgcmV0dXJuIHZhbHVlIG9mIGNhbGxpbmcgW2BERFAuY29ubmVjdGBdKCNkZHBfY29ubmVjdCkgdG8gc3BlY2lmeSBhIGRpZmZlcmVudCBzZXJ2ZXIuIFBhc3MgYG51bGxgIHRvIHNwZWNpZnkgbm8gY29ubmVjdGlvbi4gVW5tYW5hZ2VkIChgbmFtZWAgaXMgbnVsbCkgY29sbGVjdGlvbnMgY2Fubm90IHNwZWNpZnkgYSBjb25uZWN0aW9uLlxuICogQHBhcmFtIHtTdHJpbmd9IG9wdGlvbnMuaWRHZW5lcmF0aW9uIFRoZSBtZXRob2Qgb2YgZ2VuZXJhdGluZyB0aGUgYF9pZGAgZmllbGRzIG9mIG5ldyBkb2N1bWVudHMgaW4gdGhpcyBjb2xsZWN0aW9uLiAgUG9zc2libGUgdmFsdWVzOlxuXG4gLSAqKmAnU1RSSU5HJ2AqKjogcmFuZG9tIHN0cmluZ3NcbiAtICoqYCdNT05HTydgKio6ICByYW5kb20gW2BNb25nby5PYmplY3RJRGBdKCNtb25nb19vYmplY3RfaWQpIHZhbHVlc1xuXG5UaGUgZGVmYXVsdCBpZCBnZW5lcmF0aW9uIHRlY2huaXF1ZSBpcyBgJ1NUUklORydgLlxuICogQHBhcmFtIHtGdW5jdGlvbn0gb3B0aW9ucy50cmFuc2Zvcm0gQW4gb3B0aW9uYWwgdHJhbnNmb3JtYXRpb24gZnVuY3Rpb24uIERvY3VtZW50cyB3aWxsIGJlIHBhc3NlZCB0aHJvdWdoIHRoaXMgZnVuY3Rpb24gYmVmb3JlIGJlaW5nIHJldHVybmVkIGZyb20gYGZldGNoYCBvciBgZmluZE9uZWAsIGFuZCBiZWZvcmUgYmVpbmcgcGFzc2VkIHRvIGNhbGxiYWNrcyBvZiBgb2JzZXJ2ZWAsIGBtYXBgLCBgZm9yRWFjaGAsIGBhbGxvd2AsIGFuZCBgZGVueWAuIFRyYW5zZm9ybXMgYXJlICpub3QqIGFwcGxpZWQgZm9yIHRoZSBjYWxsYmFja3Mgb2YgYG9ic2VydmVDaGFuZ2VzYCBvciB0byBjdXJzb3JzIHJldHVybmVkIGZyb20gcHVibGlzaCBmdW5jdGlvbnMuXG4gKiBAcGFyYW0ge0Jvb2xlYW59IG9wdGlvbnMuZGVmaW5lTXV0YXRpb25NZXRob2RzIFNldCB0byBgZmFsc2VgIHRvIHNraXAgc2V0dGluZyB1cCB0aGUgbXV0YXRpb24gbWV0aG9kcyB0aGF0IGVuYWJsZSBpbnNlcnQvdXBkYXRlL3JlbW92ZSBmcm9tIGNsaWVudCBjb2RlLiBEZWZhdWx0IGB0cnVlYC5cbiAqL1xuTW9uZ28uQ29sbGVjdGlvbiA9IGZ1bmN0aW9uIENvbGxlY3Rpb24obmFtZSwgb3B0aW9ucykge1xuICBpZiAoIW5hbWUgJiYgKG5hbWUgIT09IG51bGwpKSB7XG4gICAgTWV0ZW9yLl9kZWJ1ZyhcIldhcm5pbmc6IGNyZWF0aW5nIGFub255bW91cyBjb2xsZWN0aW9uLiBJdCB3aWxsIG5vdCBiZSBcIiArXG4gICAgICAgICAgICAgICAgICBcInNhdmVkIG9yIHN5bmNocm9uaXplZCBvdmVyIHRoZSBuZXR3b3JrLiAoUGFzcyBudWxsIGZvciBcIiArXG4gICAgICAgICAgICAgICAgICBcInRoZSBjb2xsZWN0aW9uIG5hbWUgdG8gdHVybiBvZmYgdGhpcyB3YXJuaW5nLilcIik7XG4gICAgbmFtZSA9IG51bGw7XG4gIH1cblxuICBpZiAobmFtZSAhPT0gbnVsbCAmJiB0eXBlb2YgbmFtZSAhPT0gXCJzdHJpbmdcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiRmlyc3QgYXJndW1lbnQgdG8gbmV3IE1vbmdvLkNvbGxlY3Rpb24gbXVzdCBiZSBhIHN0cmluZyBvciBudWxsXCIpO1xuICB9XG5cbiAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5tZXRob2RzKSB7XG4gICAgLy8gQmFja3dhcmRzIGNvbXBhdGliaWxpdHkgaGFjayB3aXRoIG9yaWdpbmFsIHNpZ25hdHVyZSAod2hpY2ggcGFzc2VkXG4gICAgLy8gXCJjb25uZWN0aW9uXCIgZGlyZWN0bHkgaW5zdGVhZCBvZiBpbiBvcHRpb25zLiAoQ29ubmVjdGlvbnMgbXVzdCBoYXZlIGEgXCJtZXRob2RzXCJcbiAgICAvLyBtZXRob2QuKVxuICAgIC8vIFhYWCByZW1vdmUgYmVmb3JlIDEuMFxuICAgIG9wdGlvbnMgPSB7Y29ubmVjdGlvbjogb3B0aW9uc307XG4gIH1cbiAgLy8gQmFja3dhcmRzIGNvbXBhdGliaWxpdHk6IFwiY29ubmVjdGlvblwiIHVzZWQgdG8gYmUgY2FsbGVkIFwibWFuYWdlclwiLlxuICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLm1hbmFnZXIgJiYgIW9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgIG9wdGlvbnMuY29ubmVjdGlvbiA9IG9wdGlvbnMubWFuYWdlcjtcbiAgfVxuXG4gIG9wdGlvbnMgPSB7XG4gICAgY29ubmVjdGlvbjogdW5kZWZpbmVkLFxuICAgIGlkR2VuZXJhdGlvbjogJ1NUUklORycsXG4gICAgdHJhbnNmb3JtOiBudWxsLFxuICAgIF9kcml2ZXI6IHVuZGVmaW5lZCxcbiAgICBfcHJldmVudEF1dG9wdWJsaXNoOiBmYWxzZSxcbiAgICAgIC4uLm9wdGlvbnMsXG4gIH07XG5cbiAgc3dpdGNoIChvcHRpb25zLmlkR2VuZXJhdGlvbikge1xuICBjYXNlICdNT05HTyc6XG4gICAgdGhpcy5fbWFrZU5ld0lEID0gZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIHNyYyA9IG5hbWUgPyBERFAucmFuZG9tU3RyZWFtKCcvY29sbGVjdGlvbi8nICsgbmFtZSkgOiBSYW5kb20uaW5zZWN1cmU7XG4gICAgICByZXR1cm4gbmV3IE1vbmdvLk9iamVjdElEKHNyYy5oZXhTdHJpbmcoMjQpKTtcbiAgICB9O1xuICAgIGJyZWFrO1xuICBjYXNlICdTVFJJTkcnOlxuICBkZWZhdWx0OlxuICAgIHRoaXMuX21ha2VOZXdJRCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBzcmMgPSBuYW1lID8gRERQLnJhbmRvbVN0cmVhbSgnL2NvbGxlY3Rpb24vJyArIG5hbWUpIDogUmFuZG9tLmluc2VjdXJlO1xuICAgICAgcmV0dXJuIHNyYy5pZCgpO1xuICAgIH07XG4gICAgYnJlYWs7XG4gIH1cblxuICB0aGlzLl90cmFuc2Zvcm0gPSBMb2NhbENvbGxlY3Rpb24ud3JhcFRyYW5zZm9ybShvcHRpb25zLnRyYW5zZm9ybSk7XG5cbiAgaWYgKCEgbmFtZSB8fCBvcHRpb25zLmNvbm5lY3Rpb24gPT09IG51bGwpXG4gICAgLy8gbm90ZTogbmFtZWxlc3MgY29sbGVjdGlvbnMgbmV2ZXIgaGF2ZSBhIGNvbm5lY3Rpb25cbiAgICB0aGlzLl9jb25uZWN0aW9uID0gbnVsbDtcbiAgZWxzZSBpZiAob3B0aW9ucy5jb25uZWN0aW9uKVxuICAgIHRoaXMuX2Nvbm5lY3Rpb24gPSBvcHRpb25zLmNvbm5lY3Rpb247XG4gIGVsc2UgaWYgKE1ldGVvci5pc0NsaWVudClcbiAgICB0aGlzLl9jb25uZWN0aW9uID0gTWV0ZW9yLmNvbm5lY3Rpb247XG4gIGVsc2VcbiAgICB0aGlzLl9jb25uZWN0aW9uID0gTWV0ZW9yLnNlcnZlcjtcblxuICBpZiAoIW9wdGlvbnMuX2RyaXZlcikge1xuICAgIC8vIFhYWCBUaGlzIGNoZWNrIGFzc3VtZXMgdGhhdCB3ZWJhcHAgaXMgbG9hZGVkIHNvIHRoYXQgTWV0ZW9yLnNlcnZlciAhPT1cbiAgICAvLyBudWxsLiBXZSBzaG91bGQgZnVsbHkgc3VwcG9ydCB0aGUgY2FzZSBvZiBcIndhbnQgdG8gdXNlIGEgTW9uZ28tYmFja2VkXG4gICAgLy8gY29sbGVjdGlvbiBmcm9tIE5vZGUgY29kZSB3aXRob3V0IHdlYmFwcFwiLCBidXQgd2UgZG9uJ3QgeWV0LlxuICAgIC8vICNNZXRlb3JTZXJ2ZXJOdWxsXG4gICAgaWYgKG5hbWUgJiYgdGhpcy5fY29ubmVjdGlvbiA9PT0gTWV0ZW9yLnNlcnZlciAmJlxuICAgICAgICB0eXBlb2YgTW9uZ29JbnRlcm5hbHMgIT09IFwidW5kZWZpbmVkXCIgJiZcbiAgICAgICAgTW9uZ29JbnRlcm5hbHMuZGVmYXVsdFJlbW90ZUNvbGxlY3Rpb25Ecml2ZXIpIHtcbiAgICAgIG9wdGlvbnMuX2RyaXZlciA9IE1vbmdvSW50ZXJuYWxzLmRlZmF1bHRSZW1vdGVDb2xsZWN0aW9uRHJpdmVyKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHsgTG9jYWxDb2xsZWN0aW9uRHJpdmVyIH0gPVxuICAgICAgICByZXF1aXJlKFwiLi9sb2NhbF9jb2xsZWN0aW9uX2RyaXZlci5qc1wiKTtcbiAgICAgIG9wdGlvbnMuX2RyaXZlciA9IExvY2FsQ29sbGVjdGlvbkRyaXZlcjtcbiAgICB9XG4gIH1cblxuICB0aGlzLl9jb2xsZWN0aW9uID0gb3B0aW9ucy5fZHJpdmVyLm9wZW4obmFtZSwgdGhpcy5fY29ubmVjdGlvbik7XG4gIHRoaXMuX25hbWUgPSBuYW1lO1xuICB0aGlzLl9kcml2ZXIgPSBvcHRpb25zLl9kcml2ZXI7XG5cbiAgdGhpcy5fbWF5YmVTZXRVcFJlcGxpY2F0aW9uKG5hbWUsIG9wdGlvbnMpO1xuXG4gIC8vIFhYWCBkb24ndCBkZWZpbmUgdGhlc2UgdW50aWwgYWxsb3cgb3IgZGVueSBpcyBhY3R1YWxseSB1c2VkIGZvciB0aGlzXG4gIC8vIGNvbGxlY3Rpb24uIENvdWxkIGJlIGhhcmQgaWYgdGhlIHNlY3VyaXR5IHJ1bGVzIGFyZSBvbmx5IGRlZmluZWQgb24gdGhlXG4gIC8vIHNlcnZlci5cbiAgaWYgKG9wdGlvbnMuZGVmaW5lTXV0YXRpb25NZXRob2RzICE9PSBmYWxzZSkge1xuICAgIHRyeSB7XG4gICAgICB0aGlzLl9kZWZpbmVNdXRhdGlvbk1ldGhvZHMoe1xuICAgICAgICB1c2VFeGlzdGluZzogb3B0aW9ucy5fc3VwcHJlc3NTYW1lTmFtZUVycm9yID09PSB0cnVlXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgLy8gVGhyb3cgYSBtb3JlIHVuZGVyc3RhbmRhYmxlIGVycm9yIG9uIHRoZSBzZXJ2ZXIgZm9yIHNhbWUgY29sbGVjdGlvbiBuYW1lXG4gICAgICBpZiAoZXJyb3IubWVzc2FnZSA9PT0gYEEgbWV0aG9kIG5hbWVkICcvJHtuYW1lfS9pbnNlcnQnIGlzIGFscmVhZHkgZGVmaW5lZGApXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVGhlcmUgaXMgYWxyZWFkeSBhIGNvbGxlY3Rpb24gbmFtZWQgXCIke25hbWV9XCJgKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuXG4gIC8vIGF1dG9wdWJsaXNoXG4gIGlmIChQYWNrYWdlLmF1dG9wdWJsaXNoICYmXG4gICAgICAhIG9wdGlvbnMuX3ByZXZlbnRBdXRvcHVibGlzaCAmJlxuICAgICAgdGhpcy5fY29ubmVjdGlvbiAmJlxuICAgICAgdGhpcy5fY29ubmVjdGlvbi5wdWJsaXNoKSB7XG4gICAgdGhpcy5fY29ubmVjdGlvbi5wdWJsaXNoKG51bGwsICgpID0+IHRoaXMuZmluZCgpLCB7XG4gICAgICBpc19hdXRvOiB0cnVlLFxuICAgIH0pO1xuICB9XG59O1xuXG5PYmplY3QuYXNzaWduKE1vbmdvLkNvbGxlY3Rpb24ucHJvdG90eXBlLCB7XG4gIF9tYXliZVNldFVwUmVwbGljYXRpb24obmFtZSwge1xuICAgIF9zdXBwcmVzc1NhbWVOYW1lRXJyb3IgPSBmYWxzZVxuICB9KSB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgaWYgKCEgKHNlbGYuX2Nvbm5lY3Rpb24gJiZcbiAgICAgICAgICAgc2VsZi5fY29ubmVjdGlvbi5yZWdpc3RlclN0b3JlKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIE9LLCB3ZSdyZSBnb2luZyB0byBiZSBhIHNsYXZlLCByZXBsaWNhdGluZyBzb21lIHJlbW90ZVxuICAgIC8vIGRhdGFiYXNlLCBleGNlcHQgcG9zc2libHkgd2l0aCBzb21lIHRlbXBvcmFyeSBkaXZlcmdlbmNlIHdoaWxlXG4gICAgLy8gd2UgaGF2ZSB1bmFja25vd2xlZGdlZCBSUEMncy5cbiAgICBjb25zdCBvayA9IHNlbGYuX2Nvbm5lY3Rpb24ucmVnaXN0ZXJTdG9yZShuYW1lLCB7XG4gICAgICAvLyBDYWxsZWQgYXQgdGhlIGJlZ2lubmluZyBvZiBhIGJhdGNoIG9mIHVwZGF0ZXMuIGJhdGNoU2l6ZSBpcyB0aGUgbnVtYmVyXG4gICAgICAvLyBvZiB1cGRhdGUgY2FsbHMgdG8gZXhwZWN0LlxuICAgICAgLy9cbiAgICAgIC8vIFhYWCBUaGlzIGludGVyZmFjZSBpcyBwcmV0dHkgamFua3kuIHJlc2V0IHByb2JhYmx5IG91Z2h0IHRvIGdvIGJhY2sgdG9cbiAgICAgIC8vIGJlaW5nIGl0cyBvd24gZnVuY3Rpb24sIGFuZCBjYWxsZXJzIHNob3VsZG4ndCBoYXZlIHRvIGNhbGN1bGF0ZVxuICAgICAgLy8gYmF0Y2hTaXplLiBUaGUgb3B0aW1pemF0aW9uIG9mIG5vdCBjYWxsaW5nIHBhdXNlL3JlbW92ZSBzaG91bGQgYmVcbiAgICAgIC8vIGRlbGF5ZWQgdW50aWwgbGF0ZXI6IHRoZSBmaXJzdCBjYWxsIHRvIHVwZGF0ZSgpIHNob3VsZCBidWZmZXIgaXRzXG4gICAgICAvLyBtZXNzYWdlLCBhbmQgdGhlbiB3ZSBjYW4gZWl0aGVyIGRpcmVjdGx5IGFwcGx5IGl0IGF0IGVuZFVwZGF0ZSB0aW1lIGlmXG4gICAgICAvLyBpdCB3YXMgdGhlIG9ubHkgdXBkYXRlLCBvciBkbyBwYXVzZU9ic2VydmVycy9hcHBseS9hcHBseSBhdCB0aGUgbmV4dFxuICAgICAgLy8gdXBkYXRlKCkgaWYgdGhlcmUncyBhbm90aGVyIG9uZS5cbiAgICAgIGJlZ2luVXBkYXRlKGJhdGNoU2l6ZSwgcmVzZXQpIHtcbiAgICAgICAgLy8gcGF1c2Ugb2JzZXJ2ZXJzIHNvIHVzZXJzIGRvbid0IHNlZSBmbGlja2VyIHdoZW4gdXBkYXRpbmcgc2V2ZXJhbFxuICAgICAgICAvLyBvYmplY3RzIGF0IG9uY2UgKGluY2x1ZGluZyB0aGUgcG9zdC1yZWNvbm5lY3QgcmVzZXQtYW5kLXJlYXBwbHlcbiAgICAgICAgLy8gc3RhZ2UpLCBhbmQgc28gdGhhdCBhIHJlLXNvcnRpbmcgb2YgYSBxdWVyeSBjYW4gdGFrZSBhZHZhbnRhZ2Ugb2YgdGhlXG4gICAgICAgIC8vIGZ1bGwgX2RpZmZRdWVyeSBtb3ZlZCBjYWxjdWxhdGlvbiBpbnN0ZWFkIG9mIGFwcGx5aW5nIGNoYW5nZSBvbmUgYXQgYVxuICAgICAgICAvLyB0aW1lLlxuICAgICAgICBpZiAoYmF0Y2hTaXplID4gMSB8fCByZXNldClcbiAgICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLnBhdXNlT2JzZXJ2ZXJzKCk7XG5cbiAgICAgICAgaWYgKHJlc2V0KVxuICAgICAgICAgIHNlbGYuX2NvbGxlY3Rpb24ucmVtb3ZlKHt9KTtcbiAgICAgIH0sXG5cbiAgICAgIC8vIEFwcGx5IGFuIHVwZGF0ZS5cbiAgICAgIC8vIFhYWCBiZXR0ZXIgc3BlY2lmeSB0aGlzIGludGVyZmFjZSAobm90IGluIHRlcm1zIG9mIGEgd2lyZSBtZXNzYWdlKT9cbiAgICAgIHVwZGF0ZShtc2cpIHtcbiAgICAgICAgdmFyIG1vbmdvSWQgPSBNb25nb0lELmlkUGFyc2UobXNnLmlkKTtcbiAgICAgICAgdmFyIGRvYyA9IHNlbGYuX2NvbGxlY3Rpb24uZmluZE9uZShtb25nb0lkKTtcblxuICAgICAgICAvLyBJcyB0aGlzIGEgXCJyZXBsYWNlIHRoZSB3aG9sZSBkb2NcIiBtZXNzYWdlIGNvbWluZyBmcm9tIHRoZSBxdWllc2NlbmNlXG4gICAgICAgIC8vIG9mIG1ldGhvZCB3cml0ZXMgdG8gYW4gb2JqZWN0PyAoTm90ZSB0aGF0ICd1bmRlZmluZWQnIGlzIGEgdmFsaWRcbiAgICAgICAgLy8gdmFsdWUgbWVhbmluZyBcInJlbW92ZSBpdFwiLilcbiAgICAgICAgaWYgKG1zZy5tc2cgPT09ICdyZXBsYWNlJykge1xuICAgICAgICAgIHZhciByZXBsYWNlID0gbXNnLnJlcGxhY2U7XG4gICAgICAgICAgaWYgKCFyZXBsYWNlKSB7XG4gICAgICAgICAgICBpZiAoZG9jKVxuICAgICAgICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLnJlbW92ZShtb25nb0lkKTtcbiAgICAgICAgICB9IGVsc2UgaWYgKCFkb2MpIHtcbiAgICAgICAgICAgIHNlbGYuX2NvbGxlY3Rpb24uaW5zZXJ0KHJlcGxhY2UpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBYWFggY2hlY2sgdGhhdCByZXBsYWNlIGhhcyBubyAkIG9wc1xuICAgICAgICAgICAgc2VsZi5fY29sbGVjdGlvbi51cGRhdGUobW9uZ29JZCwgcmVwbGFjZSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBlbHNlIGlmIChtc2cubXNnID09PSAnYWRkZWQnKSB7XG4gICAgICAgICAgaWYgKGRvYykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRXhwZWN0ZWQgbm90IHRvIGZpbmQgYSBkb2N1bWVudCBhbHJlYWR5IHByZXNlbnQgZm9yIGFuIGFkZFwiKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgc2VsZi5fY29sbGVjdGlvbi5pbnNlcnQoeyBfaWQ6IG1vbmdvSWQsIC4uLm1zZy5maWVsZHMgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAobXNnLm1zZyA9PT0gJ3JlbW92ZWQnKSB7XG4gICAgICAgICAgaWYgKCFkb2MpXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJFeHBlY3RlZCB0byBmaW5kIGEgZG9jdW1lbnQgYWxyZWFkeSBwcmVzZW50IGZvciByZW1vdmVkXCIpO1xuICAgICAgICAgIHNlbGYuX2NvbGxlY3Rpb24ucmVtb3ZlKG1vbmdvSWQpO1xuICAgICAgICB9IGVsc2UgaWYgKG1zZy5tc2cgPT09ICdjaGFuZ2VkJykge1xuICAgICAgICAgIGlmICghZG9jKVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRXhwZWN0ZWQgdG8gZmluZCBhIGRvY3VtZW50IHRvIGNoYW5nZVwiKTtcbiAgICAgICAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXMobXNnLmZpZWxkcyk7XG4gICAgICAgICAgaWYgKGtleXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgdmFyIG1vZGlmaWVyID0ge307XG4gICAgICAgICAgICBrZXlzLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBtc2cuZmllbGRzW2tleV07XG4gICAgICAgICAgICAgIGlmIChFSlNPTi5lcXVhbHMoZG9jW2tleV0sIHZhbHVlKSkge1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFtb2RpZmllci4kdW5zZXQpIHtcbiAgICAgICAgICAgICAgICAgIG1vZGlmaWVyLiR1bnNldCA9IHt9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtb2RpZmllci4kdW5zZXRba2V5XSA9IDE7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKCFtb2RpZmllci4kc2V0KSB7XG4gICAgICAgICAgICAgICAgICBtb2RpZmllci4kc2V0ID0ge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1vZGlmaWVyLiRzZXRba2V5XSA9IHZhbHVlO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGlmIChPYmplY3Qua2V5cyhtb2RpZmllcikubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLnVwZGF0ZShtb25nb0lkLCBtb2RpZmllcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkkgZG9uJ3Qga25vdyBob3cgdG8gZGVhbCB3aXRoIHRoaXMgbWVzc2FnZVwiKTtcbiAgICAgICAgfVxuICAgICAgfSxcblxuICAgICAgLy8gQ2FsbGVkIGF0IHRoZSBlbmQgb2YgYSBiYXRjaCBvZiB1cGRhdGVzLlxuICAgICAgZW5kVXBkYXRlKCkge1xuICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLnJlc3VtZU9ic2VydmVycygpO1xuICAgICAgfSxcblxuICAgICAgLy8gQ2FsbGVkIGFyb3VuZCBtZXRob2Qgc3R1YiBpbnZvY2F0aW9ucyB0byBjYXB0dXJlIHRoZSBvcmlnaW5hbCB2ZXJzaW9uc1xuICAgICAgLy8gb2YgbW9kaWZpZWQgZG9jdW1lbnRzLlxuICAgICAgc2F2ZU9yaWdpbmFscygpIHtcbiAgICAgICAgc2VsZi5fY29sbGVjdGlvbi5zYXZlT3JpZ2luYWxzKCk7XG4gICAgICB9LFxuICAgICAgcmV0cmlldmVPcmlnaW5hbHMoKSB7XG4gICAgICAgIHJldHVybiBzZWxmLl9jb2xsZWN0aW9uLnJldHJpZXZlT3JpZ2luYWxzKCk7XG4gICAgICB9LFxuXG4gICAgICAvLyBVc2VkIHRvIHByZXNlcnZlIGN1cnJlbnQgdmVyc2lvbnMgb2YgZG9jdW1lbnRzIGFjcm9zcyBhIHN0b3JlIHJlc2V0LlxuICAgICAgZ2V0RG9jKGlkKSB7XG4gICAgICAgIHJldHVybiBzZWxmLmZpbmRPbmUoaWQpO1xuICAgICAgfSxcblxuICAgICAgLy8gVG8gYmUgYWJsZSB0byBnZXQgYmFjayB0byB0aGUgY29sbGVjdGlvbiBmcm9tIHRoZSBzdG9yZS5cbiAgICAgIF9nZXRDb2xsZWN0aW9uKCkge1xuICAgICAgICByZXR1cm4gc2VsZjtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGlmICghIG9rKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYFRoZXJlIGlzIGFscmVhZHkgYSBjb2xsZWN0aW9uIG5hbWVkIFwiJHtuYW1lfVwiYDtcbiAgICAgIGlmIChfc3VwcHJlc3NTYW1lTmFtZUVycm9yID09PSB0cnVlKSB7XG4gICAgICAgIC8vIFhYWCBJbiB0aGVvcnkgd2UgZG8gbm90IGhhdmUgdG8gdGhyb3cgd2hlbiBgb2tgIGlzIGZhbHN5LiBUaGVcbiAgICAgICAgLy8gc3RvcmUgaXMgYWxyZWFkeSBkZWZpbmVkIGZvciB0aGlzIGNvbGxlY3Rpb24gbmFtZSwgYnV0IHRoaXNcbiAgICAgICAgLy8gd2lsbCBzaW1wbHkgYmUgYW5vdGhlciByZWZlcmVuY2UgdG8gaXQgYW5kIGV2ZXJ5dGhpbmcgc2hvdWxkXG4gICAgICAgIC8vIHdvcmsuIEhvd2V2ZXIsIHdlIGhhdmUgaGlzdG9yaWNhbGx5IHRocm93biBhbiBlcnJvciBoZXJlLCBzb1xuICAgICAgICAvLyBmb3Igbm93IHdlIHdpbGwgc2tpcCB0aGUgZXJyb3Igb25seSB3aGVuIF9zdXBwcmVzc1NhbWVOYW1lRXJyb3JcbiAgICAgICAgLy8gaXMgYHRydWVgLCBhbGxvd2luZyBwZW9wbGUgdG8gb3B0IGluIGFuZCBnaXZlIHRoaXMgc29tZSByZWFsXG4gICAgICAgIC8vIHdvcmxkIHRlc3RpbmcuXG4gICAgICAgIGNvbnNvbGUud2FybiA/IGNvbnNvbGUud2FybihtZXNzYWdlKSA6IGNvbnNvbGUubG9nKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgfVxuICAgIH1cbiAgfSxcblxuICAvLy9cbiAgLy8vIE1haW4gY29sbGVjdGlvbiBBUElcbiAgLy8vXG5cbiAgX2dldEZpbmRTZWxlY3RvcihhcmdzKSB7XG4gICAgaWYgKGFyZ3MubGVuZ3RoID09IDApXG4gICAgICByZXR1cm4ge307XG4gICAgZWxzZVxuICAgICAgcmV0dXJuIGFyZ3NbMF07XG4gIH0sXG5cbiAgX2dldEZpbmRPcHRpb25zKGFyZ3MpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKGFyZ3MubGVuZ3RoIDwgMikge1xuICAgICAgcmV0dXJuIHsgdHJhbnNmb3JtOiBzZWxmLl90cmFuc2Zvcm0gfTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2hlY2soYXJnc1sxXSwgTWF0Y2guT3B0aW9uYWwoTWF0Y2guT2JqZWN0SW5jbHVkaW5nKHtcbiAgICAgICAgZmllbGRzOiBNYXRjaC5PcHRpb25hbChNYXRjaC5PbmVPZihPYmplY3QsIHVuZGVmaW5lZCkpLFxuICAgICAgICBzb3J0OiBNYXRjaC5PcHRpb25hbChNYXRjaC5PbmVPZihPYmplY3QsIEFycmF5LCBGdW5jdGlvbiwgdW5kZWZpbmVkKSksXG4gICAgICAgIGxpbWl0OiBNYXRjaC5PcHRpb25hbChNYXRjaC5PbmVPZihOdW1iZXIsIHVuZGVmaW5lZCkpLFxuICAgICAgICBza2lwOiBNYXRjaC5PcHRpb25hbChNYXRjaC5PbmVPZihOdW1iZXIsIHVuZGVmaW5lZCkpXG4gICAgICB9KSkpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICB0cmFuc2Zvcm06IHNlbGYuX3RyYW5zZm9ybSxcbiAgICAgICAgLi4uYXJnc1sxXSxcbiAgICAgIH07XG4gICAgfVxuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBGaW5kIHRoZSBkb2N1bWVudHMgaW4gYSBjb2xsZWN0aW9uIHRoYXQgbWF0Y2ggdGhlIHNlbGVjdG9yLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCBmaW5kXG4gICAqIEBtZW1iZXJvZiBNb25nby5Db2xsZWN0aW9uXG4gICAqIEBpbnN0YW5jZVxuICAgKiBAcGFyYW0ge01vbmdvU2VsZWN0b3J9IFtzZWxlY3Rvcl0gQSBxdWVyeSBkZXNjcmliaW5nIHRoZSBkb2N1bWVudHMgdG8gZmluZFxuICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdXG4gICAqIEBwYXJhbSB7TW9uZ29Tb3J0U3BlY2lmaWVyfSBvcHRpb25zLnNvcnQgU29ydCBvcmRlciAoZGVmYXVsdDogbmF0dXJhbCBvcmRlcilcbiAgICogQHBhcmFtIHtOdW1iZXJ9IG9wdGlvbnMuc2tpcCBOdW1iZXIgb2YgcmVzdWx0cyB0byBza2lwIGF0IHRoZSBiZWdpbm5pbmdcbiAgICogQHBhcmFtIHtOdW1iZXJ9IG9wdGlvbnMubGltaXQgTWF4aW11bSBudW1iZXIgb2YgcmVzdWx0cyB0byByZXR1cm5cbiAgICogQHBhcmFtIHtNb25nb0ZpZWxkU3BlY2lmaWVyfSBvcHRpb25zLmZpZWxkcyBEaWN0aW9uYXJ5IG9mIGZpZWxkcyB0byByZXR1cm4gb3IgZXhjbHVkZS5cbiAgICogQHBhcmFtIHtCb29sZWFufSBvcHRpb25zLnJlYWN0aXZlIChDbGllbnQgb25seSkgRGVmYXVsdCBgdHJ1ZWA7IHBhc3MgYGZhbHNlYCB0byBkaXNhYmxlIHJlYWN0aXZpdHlcbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gb3B0aW9ucy50cmFuc2Zvcm0gT3ZlcnJpZGVzIGB0cmFuc2Zvcm1gIG9uIHRoZSAgW2BDb2xsZWN0aW9uYF0oI2NvbGxlY3Rpb25zKSBmb3IgdGhpcyBjdXJzb3IuICBQYXNzIGBudWxsYCB0byBkaXNhYmxlIHRyYW5zZm9ybWF0aW9uLlxuICAgKiBAcGFyYW0ge0Jvb2xlYW59IG9wdGlvbnMuZGlzYWJsZU9wbG9nIChTZXJ2ZXIgb25seSkgUGFzcyB0cnVlIHRvIGRpc2FibGUgb3Bsb2ctdGFpbGluZyBvbiB0aGlzIHF1ZXJ5LiBUaGlzIGFmZmVjdHMgdGhlIHdheSBzZXJ2ZXIgcHJvY2Vzc2VzIGNhbGxzIHRvIGBvYnNlcnZlYCBvbiB0aGlzIHF1ZXJ5LiBEaXNhYmxpbmcgdGhlIG9wbG9nIGNhbiBiZSB1c2VmdWwgd2hlbiB3b3JraW5nIHdpdGggZGF0YSB0aGF0IHVwZGF0ZXMgaW4gbGFyZ2UgYmF0Y2hlcy5cbiAgICogQHBhcmFtIHtOdW1iZXJ9IG9wdGlvbnMucG9sbGluZ0ludGVydmFsTXMgKFNlcnZlciBvbmx5KSBXaGVuIG9wbG9nIGlzIGRpc2FibGVkICh0aHJvdWdoIHRoZSB1c2Ugb2YgYGRpc2FibGVPcGxvZ2Agb3Igd2hlbiBvdGhlcndpc2Ugbm90IGF2YWlsYWJsZSksIHRoZSBmcmVxdWVuY3kgKGluIG1pbGxpc2Vjb25kcykgb2YgaG93IG9mdGVuIHRvIHBvbGwgdGhpcyBxdWVyeSB3aGVuIG9ic2VydmluZyBvbiB0aGUgc2VydmVyLiBEZWZhdWx0cyB0byAxMDAwMG1zICgxMCBzZWNvbmRzKS5cbiAgICogQHBhcmFtIHtOdW1iZXJ9IG9wdGlvbnMucG9sbGluZ1Rocm90dGxlTXMgKFNlcnZlciBvbmx5KSBXaGVuIG9wbG9nIGlzIGRpc2FibGVkICh0aHJvdWdoIHRoZSB1c2Ugb2YgYGRpc2FibGVPcGxvZ2Agb3Igd2hlbiBvdGhlcndpc2Ugbm90IGF2YWlsYWJsZSksIHRoZSBtaW5pbXVtIHRpbWUgKGluIG1pbGxpc2Vjb25kcykgdG8gYWxsb3cgYmV0d2VlbiByZS1wb2xsaW5nIHdoZW4gb2JzZXJ2aW5nIG9uIHRoZSBzZXJ2ZXIuIEluY3JlYXNpbmcgdGhpcyB3aWxsIHNhdmUgQ1BVIGFuZCBtb25nbyBsb2FkIGF0IHRoZSBleHBlbnNlIG9mIHNsb3dlciB1cGRhdGVzIHRvIHVzZXJzLiBEZWNyZWFzaW5nIHRoaXMgaXMgbm90IHJlY29tbWVuZGVkLiBEZWZhdWx0cyB0byA1MG1zLlxuICAgKiBAcGFyYW0ge051bWJlcn0gb3B0aW9ucy5tYXhUaW1lTXMgKFNlcnZlciBvbmx5KSBJZiBzZXQsIGluc3RydWN0cyBNb25nb0RCIHRvIHNldCBhIHRpbWUgbGltaXQgZm9yIHRoaXMgY3Vyc29yJ3Mgb3BlcmF0aW9ucy4gSWYgdGhlIG9wZXJhdGlvbiByZWFjaGVzIHRoZSBzcGVjaWZpZWQgdGltZSBsaW1pdCAoaW4gbWlsbGlzZWNvbmRzKSB3aXRob3V0IHRoZSBoYXZpbmcgYmVlbiBjb21wbGV0ZWQsIGFuIGV4Y2VwdGlvbiB3aWxsIGJlIHRocm93bi4gVXNlZnVsIHRvIHByZXZlbnQgYW4gKGFjY2lkZW50YWwgb3IgbWFsaWNpb3VzKSB1bm9wdGltaXplZCBxdWVyeSBmcm9tIGNhdXNpbmcgYSBmdWxsIGNvbGxlY3Rpb24gc2NhbiB0aGF0IHdvdWxkIGRpc3J1cHQgb3RoZXIgZGF0YWJhc2UgdXNlcnMsIGF0IHRoZSBleHBlbnNlIG9mIG5lZWRpbmcgdG8gaGFuZGxlIHRoZSByZXN1bHRpbmcgZXJyb3IuXG4gICAqIEBwYXJhbSB7U3RyaW5nfE9iamVjdH0gb3B0aW9ucy5oaW50IChTZXJ2ZXIgb25seSkgT3ZlcnJpZGVzIE1vbmdvREIncyBkZWZhdWx0IGluZGV4IHNlbGVjdGlvbiBhbmQgcXVlcnkgb3B0aW1pemF0aW9uIHByb2Nlc3MuIFNwZWNpZnkgYW4gaW5kZXggdG8gZm9yY2UgaXRzIHVzZSwgZWl0aGVyIGJ5IGl0cyBuYW1lIG9yIGluZGV4IHNwZWNpZmljYXRpb24uIFlvdSBjYW4gYWxzbyBzcGVjaWZ5IGB7ICRuYXR1cmFsIDogMSB9YCB0byBmb3JjZSBhIGZvcndhcmRzIGNvbGxlY3Rpb24gc2Nhbiwgb3IgYHsgJG5hdHVyYWwgOiAtMSB9YCBmb3IgYSByZXZlcnNlIGNvbGxlY3Rpb24gc2Nhbi4gU2V0dGluZyB0aGlzIGlzIG9ubHkgcmVjb21tZW5kZWQgZm9yIGFkdmFuY2VkIHVzZXJzLlxuICAgKiBAcmV0dXJucyB7TW9uZ28uQ3Vyc29yfVxuICAgKi9cbiAgZmluZCguLi5hcmdzKSB7XG4gICAgLy8gQ29sbGVjdGlvbi5maW5kKCkgKHJldHVybiBhbGwgZG9jcykgYmVoYXZlcyBkaWZmZXJlbnRseVxuICAgIC8vIGZyb20gQ29sbGVjdGlvbi5maW5kKHVuZGVmaW5lZCkgKHJldHVybiAwIGRvY3MpLiAgc28gYmVcbiAgICAvLyBjYXJlZnVsIGFib3V0IHRoZSBsZW5ndGggb2YgYXJndW1lbnRzLlxuICAgIHJldHVybiB0aGlzLl9jb2xsZWN0aW9uLmZpbmQoXG4gICAgICB0aGlzLl9nZXRGaW5kU2VsZWN0b3IoYXJncyksXG4gICAgICB0aGlzLl9nZXRGaW5kT3B0aW9ucyhhcmdzKVxuICAgICk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IEZpbmRzIHRoZSBmaXJzdCBkb2N1bWVudCB0aGF0IG1hdGNoZXMgdGhlIHNlbGVjdG9yLCBhcyBvcmRlcmVkIGJ5IHNvcnQgYW5kIHNraXAgb3B0aW9ucy4gUmV0dXJucyBgdW5kZWZpbmVkYCBpZiBubyBtYXRjaGluZyBkb2N1bWVudCBpcyBmb3VuZC5cbiAgICogQGxvY3VzIEFueXdoZXJlXG4gICAqIEBtZXRob2QgZmluZE9uZVxuICAgKiBAbWVtYmVyb2YgTW9uZ28uQ29sbGVjdGlvblxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtNb25nb1NlbGVjdG9yfSBbc2VsZWN0b3JdIEEgcXVlcnkgZGVzY3JpYmluZyB0aGUgZG9jdW1lbnRzIHRvIGZpbmRcbiAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXVxuICAgKiBAcGFyYW0ge01vbmdvU29ydFNwZWNpZmllcn0gb3B0aW9ucy5zb3J0IFNvcnQgb3JkZXIgKGRlZmF1bHQ6IG5hdHVyYWwgb3JkZXIpXG4gICAqIEBwYXJhbSB7TnVtYmVyfSBvcHRpb25zLnNraXAgTnVtYmVyIG9mIHJlc3VsdHMgdG8gc2tpcCBhdCB0aGUgYmVnaW5uaW5nXG4gICAqIEBwYXJhbSB7TW9uZ29GaWVsZFNwZWNpZmllcn0gb3B0aW9ucy5maWVsZHMgRGljdGlvbmFyeSBvZiBmaWVsZHMgdG8gcmV0dXJuIG9yIGV4Y2x1ZGUuXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gb3B0aW9ucy5yZWFjdGl2ZSAoQ2xpZW50IG9ubHkpIERlZmF1bHQgdHJ1ZTsgcGFzcyBmYWxzZSB0byBkaXNhYmxlIHJlYWN0aXZpdHlcbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gb3B0aW9ucy50cmFuc2Zvcm0gT3ZlcnJpZGVzIGB0cmFuc2Zvcm1gIG9uIHRoZSBbYENvbGxlY3Rpb25gXSgjY29sbGVjdGlvbnMpIGZvciB0aGlzIGN1cnNvci4gIFBhc3MgYG51bGxgIHRvIGRpc2FibGUgdHJhbnNmb3JtYXRpb24uXG4gICAqIEByZXR1cm5zIHtPYmplY3R9XG4gICAqL1xuICBmaW5kT25lKC4uLmFyZ3MpIHtcbiAgICByZXR1cm4gdGhpcy5fY29sbGVjdGlvbi5maW5kT25lKFxuICAgICAgdGhpcy5fZ2V0RmluZFNlbGVjdG9yKGFyZ3MpLFxuICAgICAgdGhpcy5fZ2V0RmluZE9wdGlvbnMoYXJncylcbiAgICApO1xuICB9XG59KTtcblxuT2JqZWN0LmFzc2lnbihNb25nby5Db2xsZWN0aW9uLCB7XG4gIF9wdWJsaXNoQ3Vyc29yKGN1cnNvciwgc3ViLCBjb2xsZWN0aW9uKSB7XG4gICAgdmFyIG9ic2VydmVIYW5kbGUgPSBjdXJzb3Iub2JzZXJ2ZUNoYW5nZXMoe1xuICAgICAgYWRkZWQ6IGZ1bmN0aW9uIChpZCwgZmllbGRzKSB7XG4gICAgICAgIHN1Yi5hZGRlZChjb2xsZWN0aW9uLCBpZCwgZmllbGRzKTtcbiAgICAgIH0sXG4gICAgICBjaGFuZ2VkOiBmdW5jdGlvbiAoaWQsIGZpZWxkcykge1xuICAgICAgICBzdWIuY2hhbmdlZChjb2xsZWN0aW9uLCBpZCwgZmllbGRzKTtcbiAgICAgIH0sXG4gICAgICByZW1vdmVkOiBmdW5jdGlvbiAoaWQpIHtcbiAgICAgICAgc3ViLnJlbW92ZWQoY29sbGVjdGlvbiwgaWQpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gV2UgZG9uJ3QgY2FsbCBzdWIucmVhZHkoKSBoZXJlOiBpdCBnZXRzIGNhbGxlZCBpbiBsaXZlZGF0YV9zZXJ2ZXIsIGFmdGVyXG4gICAgLy8gcG9zc2libHkgY2FsbGluZyBfcHVibGlzaEN1cnNvciBvbiBtdWx0aXBsZSByZXR1cm5lZCBjdXJzb3JzLlxuXG4gICAgLy8gcmVnaXN0ZXIgc3RvcCBjYWxsYmFjayAoZXhwZWN0cyBsYW1iZGEgdy8gbm8gYXJncykuXG4gICAgc3ViLm9uU3RvcChmdW5jdGlvbiAoKSB7XG4gICAgICBvYnNlcnZlSGFuZGxlLnN0b3AoKTtcbiAgICB9KTtcblxuICAgIC8vIHJldHVybiB0aGUgb2JzZXJ2ZUhhbmRsZSBpbiBjYXNlIGl0IG5lZWRzIHRvIGJlIHN0b3BwZWQgZWFybHlcbiAgICByZXR1cm4gb2JzZXJ2ZUhhbmRsZTtcbiAgfSxcblxuICAvLyBwcm90ZWN0IGFnYWluc3QgZGFuZ2Vyb3VzIHNlbGVjdG9ycy4gIGZhbHNleSBhbmQge19pZDogZmFsc2V5fSBhcmUgYm90aFxuICAvLyBsaWtlbHkgcHJvZ3JhbW1lciBlcnJvciwgYW5kIG5vdCB3aGF0IHlvdSB3YW50LCBwYXJ0aWN1bGFybHkgZm9yIGRlc3RydWN0aXZlXG4gIC8vIG9wZXJhdGlvbnMuIElmIGEgZmFsc2V5IF9pZCBpcyBzZW50IGluLCBhIG5ldyBzdHJpbmcgX2lkIHdpbGwgYmVcbiAgLy8gZ2VuZXJhdGVkIGFuZCByZXR1cm5lZDsgaWYgYSBmYWxsYmFja0lkIGlzIHByb3ZpZGVkLCBpdCB3aWxsIGJlIHJldHVybmVkXG4gIC8vIGluc3RlYWQuXG4gIF9yZXdyaXRlU2VsZWN0b3Ioc2VsZWN0b3IsIHsgZmFsbGJhY2tJZCB9ID0ge30pIHtcbiAgICAvLyBzaG9ydGhhbmQgLS0gc2NhbGFycyBtYXRjaCBfaWRcbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IpKVxuICAgICAgc2VsZWN0b3IgPSB7X2lkOiBzZWxlY3Rvcn07XG5cbiAgICBpZiAoQXJyYXkuaXNBcnJheShzZWxlY3RvcikpIHtcbiAgICAgIC8vIFRoaXMgaXMgY29uc2lzdGVudCB3aXRoIHRoZSBNb25nbyBjb25zb2xlIGl0c2VsZjsgaWYgd2UgZG9uJ3QgZG8gdGhpc1xuICAgICAgLy8gY2hlY2sgcGFzc2luZyBhbiBlbXB0eSBhcnJheSBlbmRzIHVwIHNlbGVjdGluZyBhbGwgaXRlbXNcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk1vbmdvIHNlbGVjdG9yIGNhbid0IGJlIGFuIGFycmF5LlwiKTtcbiAgICB9XG5cbiAgICBpZiAoIXNlbGVjdG9yIHx8ICgoJ19pZCcgaW4gc2VsZWN0b3IpICYmICFzZWxlY3Rvci5faWQpKSB7XG4gICAgICAvLyBjYW4ndCBtYXRjaCBhbnl0aGluZ1xuICAgICAgcmV0dXJuIHsgX2lkOiBmYWxsYmFja0lkIHx8IFJhbmRvbS5pZCgpIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHNlbGVjdG9yO1xuICB9XG59KTtcblxuT2JqZWN0LmFzc2lnbihNb25nby5Db2xsZWN0aW9uLnByb3RvdHlwZSwge1xuICAvLyAnaW5zZXJ0JyBpbW1lZGlhdGVseSByZXR1cm5zIHRoZSBpbnNlcnRlZCBkb2N1bWVudCdzIG5ldyBfaWQuXG4gIC8vIFRoZSBvdGhlcnMgcmV0dXJuIHZhbHVlcyBpbW1lZGlhdGVseSBpZiB5b3UgYXJlIGluIGEgc3R1YiwgYW4gaW4tbWVtb3J5XG4gIC8vIHVubWFuYWdlZCBjb2xsZWN0aW9uLCBvciBhIG1vbmdvLWJhY2tlZCBjb2xsZWN0aW9uIGFuZCB5b3UgZG9uJ3QgcGFzcyBhXG4gIC8vIGNhbGxiYWNrLiAndXBkYXRlJyBhbmQgJ3JlbW92ZScgcmV0dXJuIHRoZSBudW1iZXIgb2YgYWZmZWN0ZWRcbiAgLy8gZG9jdW1lbnRzLiAndXBzZXJ0JyByZXR1cm5zIGFuIG9iamVjdCB3aXRoIGtleXMgJ251bWJlckFmZmVjdGVkJyBhbmQsIGlmIGFuXG4gIC8vIGluc2VydCBoYXBwZW5lZCwgJ2luc2VydGVkSWQnLlxuICAvL1xuICAvLyBPdGhlcndpc2UsIHRoZSBzZW1hbnRpY3MgYXJlIGV4YWN0bHkgbGlrZSBvdGhlciBtZXRob2RzOiB0aGV5IHRha2VcbiAgLy8gYSBjYWxsYmFjayBhcyBhbiBvcHRpb25hbCBsYXN0IGFyZ3VtZW50OyBpZiBubyBjYWxsYmFjayBpc1xuICAvLyBwcm92aWRlZCwgdGhleSBibG9jayB1bnRpbCB0aGUgb3BlcmF0aW9uIGlzIGNvbXBsZXRlLCBhbmQgdGhyb3cgYW5cbiAgLy8gZXhjZXB0aW9uIGlmIGl0IGZhaWxzOyBpZiBhIGNhbGxiYWNrIGlzIHByb3ZpZGVkLCB0aGVuIHRoZXkgZG9uJ3RcbiAgLy8gbmVjZXNzYXJpbHkgYmxvY2ssIGFuZCB0aGV5IGNhbGwgdGhlIGNhbGxiYWNrIHdoZW4gdGhleSBmaW5pc2ggd2l0aCBlcnJvciBhbmRcbiAgLy8gcmVzdWx0IGFyZ3VtZW50cy4gIChUaGUgaW5zZXJ0IG1ldGhvZCBwcm92aWRlcyB0aGUgZG9jdW1lbnQgSUQgYXMgaXRzIHJlc3VsdDtcbiAgLy8gdXBkYXRlIGFuZCByZW1vdmUgcHJvdmlkZSB0aGUgbnVtYmVyIG9mIGFmZmVjdGVkIGRvY3MgYXMgdGhlIHJlc3VsdDsgdXBzZXJ0XG4gIC8vIHByb3ZpZGVzIGFuIG9iamVjdCB3aXRoIG51bWJlckFmZmVjdGVkIGFuZCBtYXliZSBpbnNlcnRlZElkLilcbiAgLy9cbiAgLy8gT24gdGhlIGNsaWVudCwgYmxvY2tpbmcgaXMgaW1wb3NzaWJsZSwgc28gaWYgYSBjYWxsYmFja1xuICAvLyBpc24ndCBwcm92aWRlZCwgdGhleSBqdXN0IHJldHVybiBpbW1lZGlhdGVseSBhbmQgYW55IGVycm9yXG4gIC8vIGluZm9ybWF0aW9uIGlzIGxvc3QuXG4gIC8vXG4gIC8vIFRoZXJlJ3Mgb25lIG1vcmUgdHdlYWsuIE9uIHRoZSBjbGllbnQsIGlmIHlvdSBkb24ndCBwcm92aWRlIGFcbiAgLy8gY2FsbGJhY2ssIHRoZW4gaWYgdGhlcmUgaXMgYW4gZXJyb3IsIGEgbWVzc2FnZSB3aWxsIGJlIGxvZ2dlZCB3aXRoXG4gIC8vIE1ldGVvci5fZGVidWcuXG4gIC8vXG4gIC8vIFRoZSBpbnRlbnQgKHRob3VnaCB0aGlzIGlzIGFjdHVhbGx5IGRldGVybWluZWQgYnkgdGhlIHVuZGVybHlpbmdcbiAgLy8gZHJpdmVycykgaXMgdGhhdCB0aGUgb3BlcmF0aW9ucyBzaG91bGQgYmUgZG9uZSBzeW5jaHJvbm91c2x5LCBub3RcbiAgLy8gZ2VuZXJhdGluZyB0aGVpciByZXN1bHQgdW50aWwgdGhlIGRhdGFiYXNlIGhhcyBhY2tub3dsZWRnZWRcbiAgLy8gdGhlbS4gSW4gdGhlIGZ1dHVyZSBtYXliZSB3ZSBzaG91bGQgcHJvdmlkZSBhIGZsYWcgdG8gdHVybiB0aGlzXG4gIC8vIG9mZi5cblxuICAvKipcbiAgICogQHN1bW1hcnkgSW5zZXJ0IGEgZG9jdW1lbnQgaW4gdGhlIGNvbGxlY3Rpb24uICBSZXR1cm5zIGl0cyB1bmlxdWUgX2lkLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCAgaW5zZXJ0XG4gICAqIEBtZW1iZXJvZiBNb25nby5Db2xsZWN0aW9uXG4gICAqIEBpbnN0YW5jZVxuICAgKiBAcGFyYW0ge09iamVjdH0gZG9jIFRoZSBkb2N1bWVudCB0byBpbnNlcnQuIE1heSBub3QgeWV0IGhhdmUgYW4gX2lkIGF0dHJpYnV0ZSwgaW4gd2hpY2ggY2FzZSBNZXRlb3Igd2lsbCBnZW5lcmF0ZSBvbmUgZm9yIHlvdS5cbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gW2NhbGxiYWNrXSBPcHRpb25hbC4gIElmIHByZXNlbnQsIGNhbGxlZCB3aXRoIGFuIGVycm9yIG9iamVjdCBhcyB0aGUgZmlyc3QgYXJndW1lbnQgYW5kLCBpZiBubyBlcnJvciwgdGhlIF9pZCBhcyB0aGUgc2Vjb25kLlxuICAgKi9cbiAgaW5zZXJ0KGRvYywgY2FsbGJhY2spIHtcbiAgICAvLyBNYWtlIHN1cmUgd2Ugd2VyZSBwYXNzZWQgYSBkb2N1bWVudCB0byBpbnNlcnRcbiAgICBpZiAoIWRvYykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiaW5zZXJ0IHJlcXVpcmVzIGFuIGFyZ3VtZW50XCIpO1xuICAgIH1cblxuICAgIC8vIE1ha2UgYSBzaGFsbG93IGNsb25lIG9mIHRoZSBkb2N1bWVudCwgcHJlc2VydmluZyBpdHMgcHJvdG90eXBlLlxuICAgIGRvYyA9IE9iamVjdC5jcmVhdGUoXG4gICAgICBPYmplY3QuZ2V0UHJvdG90eXBlT2YoZG9jKSxcbiAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3JzKGRvYylcbiAgICApO1xuXG4gICAgaWYgKCdfaWQnIGluIGRvYykge1xuICAgICAgaWYgKCEgZG9jLl9pZCB8fFxuICAgICAgICAgICEgKHR5cGVvZiBkb2MuX2lkID09PSAnc3RyaW5nJyB8fFxuICAgICAgICAgICAgIGRvYy5faWQgaW5zdGFuY2VvZiBNb25nby5PYmplY3RJRCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiTWV0ZW9yIHJlcXVpcmVzIGRvY3VtZW50IF9pZCBmaWVsZHMgdG8gYmUgbm9uLWVtcHR5IHN0cmluZ3Mgb3IgT2JqZWN0SURzXCIpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBsZXQgZ2VuZXJhdGVJZCA9IHRydWU7XG5cbiAgICAgIC8vIERvbid0IGdlbmVyYXRlIHRoZSBpZCBpZiB3ZSdyZSB0aGUgY2xpZW50IGFuZCB0aGUgJ291dGVybW9zdCcgY2FsbFxuICAgICAgLy8gVGhpcyBvcHRpbWl6YXRpb24gc2F2ZXMgdXMgcGFzc2luZyBib3RoIHRoZSByYW5kb21TZWVkIGFuZCB0aGUgaWRcbiAgICAgIC8vIFBhc3NpbmcgYm90aCBpcyByZWR1bmRhbnQuXG4gICAgICBpZiAodGhpcy5faXNSZW1vdGVDb2xsZWN0aW9uKCkpIHtcbiAgICAgICAgY29uc3QgZW5jbG9zaW5nID0gRERQLl9DdXJyZW50TWV0aG9kSW52b2NhdGlvbi5nZXQoKTtcbiAgICAgICAgaWYgKCFlbmNsb3NpbmcpIHtcbiAgICAgICAgICBnZW5lcmF0ZUlkID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKGdlbmVyYXRlSWQpIHtcbiAgICAgICAgZG9jLl9pZCA9IHRoaXMuX21ha2VOZXdJRCgpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIE9uIGluc2VydHMsIGFsd2F5cyByZXR1cm4gdGhlIGlkIHRoYXQgd2UgZ2VuZXJhdGVkOyBvbiBhbGwgb3RoZXJcbiAgICAvLyBvcGVyYXRpb25zLCBqdXN0IHJldHVybiB0aGUgcmVzdWx0IGZyb20gdGhlIGNvbGxlY3Rpb24uXG4gICAgdmFyIGNob29zZVJldHVyblZhbHVlRnJvbUNvbGxlY3Rpb25SZXN1bHQgPSBmdW5jdGlvbiAocmVzdWx0KSB7XG4gICAgICBpZiAoZG9jLl9pZCkge1xuICAgICAgICByZXR1cm4gZG9jLl9pZDtcbiAgICAgIH1cblxuICAgICAgLy8gWFhYIHdoYXQgaXMgdGhpcyBmb3I/P1xuICAgICAgLy8gSXQncyBzb21lIGl0ZXJhY3Rpb24gYmV0d2VlbiB0aGUgY2FsbGJhY2sgdG8gX2NhbGxNdXRhdG9yTWV0aG9kIGFuZFxuICAgICAgLy8gdGhlIHJldHVybiB2YWx1ZSBjb252ZXJzaW9uXG4gICAgICBkb2MuX2lkID0gcmVzdWx0O1xuXG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH07XG5cbiAgICBjb25zdCB3cmFwcGVkQ2FsbGJhY2sgPSB3cmFwQ2FsbGJhY2soXG4gICAgICBjYWxsYmFjaywgY2hvb3NlUmV0dXJuVmFsdWVGcm9tQ29sbGVjdGlvblJlc3VsdCk7XG5cbiAgICBpZiAodGhpcy5faXNSZW1vdGVDb2xsZWN0aW9uKCkpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX2NhbGxNdXRhdG9yTWV0aG9kKFwiaW5zZXJ0XCIsIFtkb2NdLCB3cmFwcGVkQ2FsbGJhY2spO1xuICAgICAgcmV0dXJuIGNob29zZVJldHVyblZhbHVlRnJvbUNvbGxlY3Rpb25SZXN1bHQocmVzdWx0KTtcbiAgICB9XG5cbiAgICAvLyBpdCdzIG15IGNvbGxlY3Rpb24uICBkZXNjZW5kIGludG8gdGhlIGNvbGxlY3Rpb24gb2JqZWN0XG4gICAgLy8gYW5kIHByb3BhZ2F0ZSBhbnkgZXhjZXB0aW9uLlxuICAgIHRyeSB7XG4gICAgICAvLyBJZiB0aGUgdXNlciBwcm92aWRlZCBhIGNhbGxiYWNrIGFuZCB0aGUgY29sbGVjdGlvbiBpbXBsZW1lbnRzIHRoaXNcbiAgICAgIC8vIG9wZXJhdGlvbiBhc3luY2hyb25vdXNseSwgdGhlbiBxdWVyeVJldCB3aWxsIGJlIHVuZGVmaW5lZCwgYW5kIHRoZVxuICAgICAgLy8gcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgdGhyb3VnaCB0aGUgY2FsbGJhY2sgaW5zdGVhZC5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX2NvbGxlY3Rpb24uaW5zZXJ0KGRvYywgd3JhcHBlZENhbGxiYWNrKTtcbiAgICAgIHJldHVybiBjaG9vc2VSZXR1cm5WYWx1ZUZyb21Db2xsZWN0aW9uUmVzdWx0KHJlc3VsdCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrKGUpO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIHRocm93IGU7XG4gICAgfVxuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBNb2RpZnkgb25lIG9yIG1vcmUgZG9jdW1lbnRzIGluIHRoZSBjb2xsZWN0aW9uLiBSZXR1cm5zIHRoZSBudW1iZXIgb2YgbWF0Y2hlZCBkb2N1bWVudHMuXG4gICAqIEBsb2N1cyBBbnl3aGVyZVxuICAgKiBAbWV0aG9kIHVwZGF0ZVxuICAgKiBAbWVtYmVyb2YgTW9uZ28uQ29sbGVjdGlvblxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtNb25nb1NlbGVjdG9yfSBzZWxlY3RvciBTcGVjaWZpZXMgd2hpY2ggZG9jdW1lbnRzIHRvIG1vZGlmeVxuICAgKiBAcGFyYW0ge01vbmdvTW9kaWZpZXJ9IG1vZGlmaWVyIFNwZWNpZmllcyBob3cgdG8gbW9kaWZ5IHRoZSBkb2N1bWVudHNcbiAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXVxuICAgKiBAcGFyYW0ge0Jvb2xlYW59IG9wdGlvbnMubXVsdGkgVHJ1ZSB0byBtb2RpZnkgYWxsIG1hdGNoaW5nIGRvY3VtZW50czsgZmFsc2UgdG8gb25seSBtb2RpZnkgb25lIG9mIHRoZSBtYXRjaGluZyBkb2N1bWVudHMgKHRoZSBkZWZhdWx0KS5cbiAgICogQHBhcmFtIHtCb29sZWFufSBvcHRpb25zLnVwc2VydCBUcnVlIHRvIGluc2VydCBhIGRvY3VtZW50IGlmIG5vIG1hdGNoaW5nIGRvY3VtZW50cyBhcmUgZm91bmQuXG4gICAqIEBwYXJhbSB7RnVuY3Rpb259IFtjYWxsYmFja10gT3B0aW9uYWwuICBJZiBwcmVzZW50LCBjYWxsZWQgd2l0aCBhbiBlcnJvciBvYmplY3QgYXMgdGhlIGZpcnN0IGFyZ3VtZW50IGFuZCwgaWYgbm8gZXJyb3IsIHRoZSBudW1iZXIgb2YgYWZmZWN0ZWQgZG9jdW1lbnRzIGFzIHRoZSBzZWNvbmQuXG4gICAqL1xuICB1cGRhdGUoc2VsZWN0b3IsIG1vZGlmaWVyLCAuLi5vcHRpb25zQW5kQ2FsbGJhY2spIHtcbiAgICBjb25zdCBjYWxsYmFjayA9IHBvcENhbGxiYWNrRnJvbUFyZ3Mob3B0aW9uc0FuZENhbGxiYWNrKTtcblxuICAgIC8vIFdlJ3ZlIGFscmVhZHkgcG9wcGVkIG9mZiB0aGUgY2FsbGJhY2ssIHNvIHdlIGFyZSBsZWZ0IHdpdGggYW4gYXJyYXlcbiAgICAvLyBvZiBvbmUgb3IgemVybyBpdGVtc1xuICAgIGNvbnN0IG9wdGlvbnMgPSB7IC4uLihvcHRpb25zQW5kQ2FsbGJhY2tbMF0gfHwgbnVsbCkgfTtcbiAgICBsZXQgaW5zZXJ0ZWRJZDtcbiAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnVwc2VydCkge1xuICAgICAgLy8gc2V0IGBpbnNlcnRlZElkYCBpZiBhYnNlbnQuICBgaW5zZXJ0ZWRJZGAgaXMgYSBNZXRlb3IgZXh0ZW5zaW9uLlxuICAgICAgaWYgKG9wdGlvbnMuaW5zZXJ0ZWRJZCkge1xuICAgICAgICBpZiAoISh0eXBlb2Ygb3B0aW9ucy5pbnNlcnRlZElkID09PSAnc3RyaW5nJyB8fCBvcHRpb25zLmluc2VydGVkSWQgaW5zdGFuY2VvZiBNb25nby5PYmplY3RJRCkpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiaW5zZXJ0ZWRJZCBtdXN0IGJlIHN0cmluZyBvciBPYmplY3RJRFwiKTtcbiAgICAgICAgaW5zZXJ0ZWRJZCA9IG9wdGlvbnMuaW5zZXJ0ZWRJZDtcbiAgICAgIH0gZWxzZSBpZiAoIXNlbGVjdG9yIHx8ICFzZWxlY3Rvci5faWQpIHtcbiAgICAgICAgaW5zZXJ0ZWRJZCA9IHRoaXMuX21ha2VOZXdJRCgpO1xuICAgICAgICBvcHRpb25zLmdlbmVyYXRlZElkID0gdHJ1ZTtcbiAgICAgICAgb3B0aW9ucy5pbnNlcnRlZElkID0gaW5zZXJ0ZWRJZDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBzZWxlY3RvciA9XG4gICAgICBNb25nby5Db2xsZWN0aW9uLl9yZXdyaXRlU2VsZWN0b3Ioc2VsZWN0b3IsIHsgZmFsbGJhY2tJZDogaW5zZXJ0ZWRJZCB9KTtcblxuICAgIGNvbnN0IHdyYXBwZWRDYWxsYmFjayA9IHdyYXBDYWxsYmFjayhjYWxsYmFjayk7XG5cbiAgICBpZiAodGhpcy5faXNSZW1vdGVDb2xsZWN0aW9uKCkpIHtcbiAgICAgIGNvbnN0IGFyZ3MgPSBbXG4gICAgICAgIHNlbGVjdG9yLFxuICAgICAgICBtb2RpZmllcixcbiAgICAgICAgb3B0aW9uc1xuICAgICAgXTtcblxuICAgICAgcmV0dXJuIHRoaXMuX2NhbGxNdXRhdG9yTWV0aG9kKFwidXBkYXRlXCIsIGFyZ3MsIHdyYXBwZWRDYWxsYmFjayk7XG4gICAgfVxuXG4gICAgLy8gaXQncyBteSBjb2xsZWN0aW9uLiAgZGVzY2VuZCBpbnRvIHRoZSBjb2xsZWN0aW9uIG9iamVjdFxuICAgIC8vIGFuZCBwcm9wYWdhdGUgYW55IGV4Y2VwdGlvbi5cbiAgICB0cnkge1xuICAgICAgLy8gSWYgdGhlIHVzZXIgcHJvdmlkZWQgYSBjYWxsYmFjayBhbmQgdGhlIGNvbGxlY3Rpb24gaW1wbGVtZW50cyB0aGlzXG4gICAgICAvLyBvcGVyYXRpb24gYXN5bmNocm9ub3VzbHksIHRoZW4gcXVlcnlSZXQgd2lsbCBiZSB1bmRlZmluZWQsIGFuZCB0aGVcbiAgICAgIC8vIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIHRocm91Z2ggdGhlIGNhbGxiYWNrIGluc3RlYWQuXG4gICAgICByZXR1cm4gdGhpcy5fY29sbGVjdGlvbi51cGRhdGUoXG4gICAgICAgIHNlbGVjdG9yLCBtb2RpZmllciwgb3B0aW9ucywgd3JhcHBlZENhbGxiYWNrKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2soZSk7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFJlbW92ZSBkb2N1bWVudHMgZnJvbSB0aGUgY29sbGVjdGlvblxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCByZW1vdmVcbiAgICogQG1lbWJlcm9mIE1vbmdvLkNvbGxlY3Rpb25cbiAgICogQGluc3RhbmNlXG4gICAqIEBwYXJhbSB7TW9uZ29TZWxlY3Rvcn0gc2VsZWN0b3IgU3BlY2lmaWVzIHdoaWNoIGRvY3VtZW50cyB0byByZW1vdmVcbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gW2NhbGxiYWNrXSBPcHRpb25hbC4gIElmIHByZXNlbnQsIGNhbGxlZCB3aXRoIGFuIGVycm9yIG9iamVjdCBhcyBpdHMgYXJndW1lbnQuXG4gICAqL1xuICByZW1vdmUoc2VsZWN0b3IsIGNhbGxiYWNrKSB7XG4gICAgc2VsZWN0b3IgPSBNb25nby5Db2xsZWN0aW9uLl9yZXdyaXRlU2VsZWN0b3Ioc2VsZWN0b3IpO1xuXG4gICAgY29uc3Qgd3JhcHBlZENhbGxiYWNrID0gd3JhcENhbGxiYWNrKGNhbGxiYWNrKTtcblxuICAgIGlmICh0aGlzLl9pc1JlbW90ZUNvbGxlY3Rpb24oKSkge1xuICAgICAgcmV0dXJuIHRoaXMuX2NhbGxNdXRhdG9yTWV0aG9kKFwicmVtb3ZlXCIsIFtzZWxlY3Rvcl0sIHdyYXBwZWRDYWxsYmFjayk7XG4gICAgfVxuXG4gICAgLy8gaXQncyBteSBjb2xsZWN0aW9uLiAgZGVzY2VuZCBpbnRvIHRoZSBjb2xsZWN0aW9uIG9iamVjdFxuICAgIC8vIGFuZCBwcm9wYWdhdGUgYW55IGV4Y2VwdGlvbi5cbiAgICB0cnkge1xuICAgICAgLy8gSWYgdGhlIHVzZXIgcHJvdmlkZWQgYSBjYWxsYmFjayBhbmQgdGhlIGNvbGxlY3Rpb24gaW1wbGVtZW50cyB0aGlzXG4gICAgICAvLyBvcGVyYXRpb24gYXN5bmNocm9ub3VzbHksIHRoZW4gcXVlcnlSZXQgd2lsbCBiZSB1bmRlZmluZWQsIGFuZCB0aGVcbiAgICAgIC8vIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIHRocm91Z2ggdGhlIGNhbGxiYWNrIGluc3RlYWQuXG4gICAgICByZXR1cm4gdGhpcy5fY29sbGVjdGlvbi5yZW1vdmUoc2VsZWN0b3IsIHdyYXBwZWRDYWxsYmFjayk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrKGUpO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIHRocm93IGU7XG4gICAgfVxuICB9LFxuXG4gIC8vIERldGVybWluZSBpZiB0aGlzIGNvbGxlY3Rpb24gaXMgc2ltcGx5IGEgbWluaW1vbmdvIHJlcHJlc2VudGF0aW9uIG9mIGEgcmVhbFxuICAvLyBkYXRhYmFzZSBvbiBhbm90aGVyIHNlcnZlclxuICBfaXNSZW1vdGVDb2xsZWN0aW9uKCkge1xuICAgIC8vIFhYWCBzZWUgI01ldGVvclNlcnZlck51bGxcbiAgICByZXR1cm4gdGhpcy5fY29ubmVjdGlvbiAmJiB0aGlzLl9jb25uZWN0aW9uICE9PSBNZXRlb3Iuc2VydmVyO1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBNb2RpZnkgb25lIG9yIG1vcmUgZG9jdW1lbnRzIGluIHRoZSBjb2xsZWN0aW9uLCBvciBpbnNlcnQgb25lIGlmIG5vIG1hdGNoaW5nIGRvY3VtZW50cyB3ZXJlIGZvdW5kLiBSZXR1cm5zIGFuIG9iamVjdCB3aXRoIGtleXMgYG51bWJlckFmZmVjdGVkYCAodGhlIG51bWJlciBvZiBkb2N1bWVudHMgbW9kaWZpZWQpICBhbmQgYGluc2VydGVkSWRgICh0aGUgdW5pcXVlIF9pZCBvZiB0aGUgZG9jdW1lbnQgdGhhdCB3YXMgaW5zZXJ0ZWQsIGlmIGFueSkuXG4gICAqIEBsb2N1cyBBbnl3aGVyZVxuICAgKiBAbWV0aG9kIHVwc2VydFxuICAgKiBAbWVtYmVyb2YgTW9uZ28uQ29sbGVjdGlvblxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtNb25nb1NlbGVjdG9yfSBzZWxlY3RvciBTcGVjaWZpZXMgd2hpY2ggZG9jdW1lbnRzIHRvIG1vZGlmeVxuICAgKiBAcGFyYW0ge01vbmdvTW9kaWZpZXJ9IG1vZGlmaWVyIFNwZWNpZmllcyBob3cgdG8gbW9kaWZ5IHRoZSBkb2N1bWVudHNcbiAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXVxuICAgKiBAcGFyYW0ge0Jvb2xlYW59IG9wdGlvbnMubXVsdGkgVHJ1ZSB0byBtb2RpZnkgYWxsIG1hdGNoaW5nIGRvY3VtZW50czsgZmFsc2UgdG8gb25seSBtb2RpZnkgb25lIG9mIHRoZSBtYXRjaGluZyBkb2N1bWVudHMgKHRoZSBkZWZhdWx0KS5cbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gW2NhbGxiYWNrXSBPcHRpb25hbC4gIElmIHByZXNlbnQsIGNhbGxlZCB3aXRoIGFuIGVycm9yIG9iamVjdCBhcyB0aGUgZmlyc3QgYXJndW1lbnQgYW5kLCBpZiBubyBlcnJvciwgdGhlIG51bWJlciBvZiBhZmZlY3RlZCBkb2N1bWVudHMgYXMgdGhlIHNlY29uZC5cbiAgICovXG4gIHVwc2VydChzZWxlY3RvciwgbW9kaWZpZXIsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gICAgaWYgKCEgY2FsbGJhY2sgJiYgdHlwZW9mIG9wdGlvbnMgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgICAgb3B0aW9ucyA9IHt9O1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLnVwZGF0ZShzZWxlY3RvciwgbW9kaWZpZXIsIHtcbiAgICAgIC4uLm9wdGlvbnMsXG4gICAgICBfcmV0dXJuT2JqZWN0OiB0cnVlLFxuICAgICAgdXBzZXJ0OiB0cnVlLFxuICAgIH0sIGNhbGxiYWNrKTtcbiAgfSxcblxuICAvLyBXZSdsbCBhY3R1YWxseSBkZXNpZ24gYW4gaW5kZXggQVBJIGxhdGVyLiBGb3Igbm93LCB3ZSBqdXN0IHBhc3MgdGhyb3VnaCB0b1xuICAvLyBNb25nbydzLCBidXQgbWFrZSBpdCBzeW5jaHJvbm91cy5cbiAgX2Vuc3VyZUluZGV4KGluZGV4LCBvcHRpb25zKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmICghc2VsZi5fY29sbGVjdGlvbi5fZW5zdXJlSW5kZXgpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4gb25seSBjYWxsIF9lbnN1cmVJbmRleCBvbiBzZXJ2ZXIgY29sbGVjdGlvbnNcIik7XG4gICAgc2VsZi5fY29sbGVjdGlvbi5fZW5zdXJlSW5kZXgoaW5kZXgsIG9wdGlvbnMpO1xuICB9LFxuXG4gIF9kcm9wSW5kZXgoaW5kZXgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKCFzZWxmLl9jb2xsZWN0aW9uLl9kcm9wSW5kZXgpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4gb25seSBjYWxsIF9kcm9wSW5kZXggb24gc2VydmVyIGNvbGxlY3Rpb25zXCIpO1xuICAgIHNlbGYuX2NvbGxlY3Rpb24uX2Ryb3BJbmRleChpbmRleCk7XG4gIH0sXG5cbiAgX2Ryb3BDb2xsZWN0aW9uKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoIXNlbGYuX2NvbGxlY3Rpb24uZHJvcENvbGxlY3Rpb24pXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4gb25seSBjYWxsIF9kcm9wQ29sbGVjdGlvbiBvbiBzZXJ2ZXIgY29sbGVjdGlvbnNcIik7XG4gICAgc2VsZi5fY29sbGVjdGlvbi5kcm9wQ29sbGVjdGlvbigpO1xuICB9LFxuXG4gIF9jcmVhdGVDYXBwZWRDb2xsZWN0aW9uKGJ5dGVTaXplLCBtYXhEb2N1bWVudHMpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKCFzZWxmLl9jb2xsZWN0aW9uLl9jcmVhdGVDYXBwZWRDb2xsZWN0aW9uKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuIG9ubHkgY2FsbCBfY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbiBvbiBzZXJ2ZXIgY29sbGVjdGlvbnNcIik7XG4gICAgc2VsZi5fY29sbGVjdGlvbi5fY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbihieXRlU2l6ZSwgbWF4RG9jdW1lbnRzKTtcbiAgfSxcblxuICAvKipcbiAgICogQHN1bW1hcnkgUmV0dXJucyB0aGUgW2BDb2xsZWN0aW9uYF0oaHR0cDovL21vbmdvZGIuZ2l0aHViLmlvL25vZGUtbW9uZ29kYi1uYXRpdmUvMy4wL2FwaS9Db2xsZWN0aW9uLmh0bWwpIG9iamVjdCBjb3JyZXNwb25kaW5nIHRvIHRoaXMgY29sbGVjdGlvbiBmcm9tIHRoZSBbbnBtIGBtb25nb2RiYCBkcml2ZXIgbW9kdWxlXShodHRwczovL3d3dy5ucG1qcy5jb20vcGFja2FnZS9tb25nb2RiKSB3aGljaCBpcyB3cmFwcGVkIGJ5IGBNb25nby5Db2xsZWN0aW9uYC5cbiAgICogQGxvY3VzIFNlcnZlclxuICAgKiBAbWVtYmVyb2YgTW9uZ28uQ29sbGVjdGlvblxuICAgKiBAaW5zdGFuY2VcbiAgICovXG4gIHJhd0NvbGxlY3Rpb24oKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmICghIHNlbGYuX2NvbGxlY3Rpb24ucmF3Q29sbGVjdGlvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuIG9ubHkgY2FsbCByYXdDb2xsZWN0aW9uIG9uIHNlcnZlciBjb2xsZWN0aW9uc1wiKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlbGYuX2NvbGxlY3Rpb24ucmF3Q29sbGVjdGlvbigpO1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBSZXR1cm5zIHRoZSBbYERiYF0oaHR0cDovL21vbmdvZGIuZ2l0aHViLmlvL25vZGUtbW9uZ29kYi1uYXRpdmUvMy4wL2FwaS9EYi5odG1sKSBvYmplY3QgY29ycmVzcG9uZGluZyB0byB0aGlzIGNvbGxlY3Rpb24ncyBkYXRhYmFzZSBjb25uZWN0aW9uIGZyb20gdGhlIFtucG0gYG1vbmdvZGJgIGRyaXZlciBtb2R1bGVdKGh0dHBzOi8vd3d3Lm5wbWpzLmNvbS9wYWNrYWdlL21vbmdvZGIpIHdoaWNoIGlzIHdyYXBwZWQgYnkgYE1vbmdvLkNvbGxlY3Rpb25gLlxuICAgKiBAbG9jdXMgU2VydmVyXG4gICAqIEBtZW1iZXJvZiBNb25nby5Db2xsZWN0aW9uXG4gICAqIEBpbnN0YW5jZVxuICAgKi9cbiAgcmF3RGF0YWJhc2UoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmICghIChzZWxmLl9kcml2ZXIubW9uZ28gJiYgc2VsZi5fZHJpdmVyLm1vbmdvLmRiKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuIG9ubHkgY2FsbCByYXdEYXRhYmFzZSBvbiBzZXJ2ZXIgY29sbGVjdGlvbnNcIik7XG4gICAgfVxuICAgIHJldHVybiBzZWxmLl9kcml2ZXIubW9uZ28uZGI7XG4gIH1cbn0pO1xuXG4vLyBDb252ZXJ0IHRoZSBjYWxsYmFjayB0byBub3QgcmV0dXJuIGEgcmVzdWx0IGlmIHRoZXJlIGlzIGFuIGVycm9yXG5mdW5jdGlvbiB3cmFwQ2FsbGJhY2soY2FsbGJhY2ssIGNvbnZlcnRSZXN1bHQpIHtcbiAgcmV0dXJuIGNhbGxiYWNrICYmIGZ1bmN0aW9uIChlcnJvciwgcmVzdWx0KSB7XG4gICAgaWYgKGVycm9yKSB7XG4gICAgICBjYWxsYmFjayhlcnJvcik7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgY29udmVydFJlc3VsdCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBjYWxsYmFjayhlcnJvciwgY29udmVydFJlc3VsdChyZXN1bHQpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2FsbGJhY2soZXJyb3IsIHJlc3VsdCk7XG4gICAgfVxuICB9O1xufVxuXG4vKipcbiAqIEBzdW1tYXJ5IENyZWF0ZSBhIE1vbmdvLXN0eWxlIGBPYmplY3RJRGAuICBJZiB5b3UgZG9uJ3Qgc3BlY2lmeSBhIGBoZXhTdHJpbmdgLCB0aGUgYE9iamVjdElEYCB3aWxsIGdlbmVyYXRlZCByYW5kb21seSAobm90IHVzaW5nIE1vbmdvREIncyBJRCBjb25zdHJ1Y3Rpb24gcnVsZXMpLlxuICogQGxvY3VzIEFueXdoZXJlXG4gKiBAY2xhc3NcbiAqIEBwYXJhbSB7U3RyaW5nfSBbaGV4U3RyaW5nXSBPcHRpb25hbC4gIFRoZSAyNC1jaGFyYWN0ZXIgaGV4YWRlY2ltYWwgY29udGVudHMgb2YgdGhlIE9iamVjdElEIHRvIGNyZWF0ZVxuICovXG5Nb25nby5PYmplY3RJRCA9IE1vbmdvSUQuT2JqZWN0SUQ7XG5cbi8qKlxuICogQHN1bW1hcnkgVG8gY3JlYXRlIGEgY3Vyc29yLCB1c2UgZmluZC4gVG8gYWNjZXNzIHRoZSBkb2N1bWVudHMgaW4gYSBjdXJzb3IsIHVzZSBmb3JFYWNoLCBtYXAsIG9yIGZldGNoLlxuICogQGNsYXNzXG4gKiBAaW5zdGFuY2VOYW1lIGN1cnNvclxuICovXG5Nb25nby5DdXJzb3IgPSBMb2NhbENvbGxlY3Rpb24uQ3Vyc29yO1xuXG4vKipcbiAqIEBkZXByZWNhdGVkIGluIDAuOS4xXG4gKi9cbk1vbmdvLkNvbGxlY3Rpb24uQ3Vyc29yID0gTW9uZ28uQ3Vyc29yO1xuXG4vKipcbiAqIEBkZXByZWNhdGVkIGluIDAuOS4xXG4gKi9cbk1vbmdvLkNvbGxlY3Rpb24uT2JqZWN0SUQgPSBNb25nby5PYmplY3RJRDtcblxuLyoqXG4gKiBAZGVwcmVjYXRlZCBpbiAwLjkuMVxuICovXG5NZXRlb3IuQ29sbGVjdGlvbiA9IE1vbmdvLkNvbGxlY3Rpb247XG5cbi8vIEFsbG93IGRlbnkgc3R1ZmYgaXMgbm93IGluIHRoZSBhbGxvdy1kZW55IHBhY2thZ2Vcbk9iamVjdC5hc3NpZ24oXG4gIE1ldGVvci5Db2xsZWN0aW9uLnByb3RvdHlwZSxcbiAgQWxsb3dEZW55LkNvbGxlY3Rpb25Qcm90b3R5cGVcbik7XG5cbmZ1bmN0aW9uIHBvcENhbGxiYWNrRnJvbUFyZ3MoYXJncykge1xuICAvLyBQdWxsIG9mZiBhbnkgY2FsbGJhY2sgKG9yIHBlcmhhcHMgYSAnY2FsbGJhY2snIHZhcmlhYmxlIHRoYXQgd2FzIHBhc3NlZFxuICAvLyBpbiB1bmRlZmluZWQsIGxpa2UgaG93ICd1cHNlcnQnIGRvZXMgaXQpLlxuICBpZiAoYXJncy5sZW5ndGggJiZcbiAgICAgIChhcmdzW2FyZ3MubGVuZ3RoIC0gMV0gPT09IHVuZGVmaW5lZCB8fFxuICAgICAgIGFyZ3NbYXJncy5sZW5ndGggLSAxXSBpbnN0YW5jZW9mIEZ1bmN0aW9uKSkge1xuICAgIHJldHVybiBhcmdzLnBvcCgpO1xuICB9XG59XG4iLCIvKipcbiAqIEBzdW1tYXJ5IEFsbG93cyBmb3IgdXNlciBzcGVjaWZpZWQgY29ubmVjdGlvbiBvcHRpb25zXG4gKiBAZXhhbXBsZSBodHRwOi8vbW9uZ29kYi5naXRodWIuaW8vbm9kZS1tb25nb2RiLW5hdGl2ZS8zLjAvcmVmZXJlbmNlL2Nvbm5lY3RpbmcvY29ubmVjdGlvbi1zZXR0aW5ncy9cbiAqIEBsb2N1cyBTZXJ2ZXJcbiAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zIFVzZXIgc3BlY2lmaWVkIE1vbmdvIGNvbm5lY3Rpb24gb3B0aW9uc1xuICovXG5Nb25nby5zZXRDb25uZWN0aW9uT3B0aW9ucyA9IGZ1bmN0aW9uIHNldENvbm5lY3Rpb25PcHRpb25zIChvcHRpb25zKSB7XG4gIGNoZWNrKG9wdGlvbnMsIE9iamVjdCk7XG4gIE1vbmdvLl9jb25uZWN0aW9uT3B0aW9ucyA9IG9wdGlvbnM7XG59OyJdfQ==
