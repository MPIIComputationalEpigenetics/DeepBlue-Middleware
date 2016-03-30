'use strict';

var Q = require('q') ;
var xmlrpc = require('xmlrpc');
var settings = require('./settings');
var users = require('./users.js')
var utils = require('./utils');

var xmlrpc_host = settings.xmlrpc_host();

var ExperimentsCacheControl = function() {
  console.log("Creating ExperimentsCacheControl");
  var self = this;
  self.collection_name = "experiments";

  self.projects_state = {};
  self.projects_data = {};
  self._project_counter = {};
  self._id_item = {};

  self.matches = 0;
  self.requests = 0;

  self.get_info = function(id, user_key) {
    console.log("experiments_cache.get_info");
    var deferred = Q.defer();

    if (id in self._id_item) {
      deferred.resolve(self._id_item[id]);
    }

    var client = xmlrpc.createClient(xmlrpc_host);
    client.methodCall('info', [id, user_key], function(error, infos) {
      if (error) {
        deferred.reject(error);
      }

      if (infos[0] == "error") {
        deferred.reject(error);
      }

      var infos_data = infos[1][0];
      var info = utils.build_info(infos_data)
      self._id_item[id] = info;
      deferred.resolve(info);
    });

    return deferred.promise;
  }

  self.get_infos = function(ids, user_key) {
    console.log("experiments_cache.get_infos()");
    var deferred = Q.defer();

    var new_ids = [];
    var cache_info = [];
    for (var i in ids) {
      var id = ids[i];
      if (id in self._id_item) {
        cache_info.push(self._id_item[id]);
      }
      else {
        new_ids.push(id);
      }
    }

    console.log(new_ids);

    if (new_ids.length != 0) {
      var client = xmlrpc.createClient(xmlrpc_host);
      client.methodCall('info', [new_ids, user_key], function(error, infos) {
        if (error) {
          deferred.reject(error);
        }
        if (infos[0] == "error") {
          deferred.reject({"error": infos[1]});
        }
        var infos_data = infos[1];
        for (var i in infos_data) {
          var info = utils.build_info(infos_data[i]);
          cache_info.push(info);
          self._id_item[info['_id']] = info;
        }
        deferred.resolve(cache_info);
      });
    }
    else {
      deferred.resolve(cache_info);
    }

    return deferred.promise;
  };

  self._info = function(id_ids, info_function, user_key)
  {
    var deferred = Q.defer();

    users.check(user_key).then(function() {
      deferred.resolve(info_function(id_ids, user_key));
    });

    return deferred.promise;
  }

  // TODO: Move to info.js and access the cache data from there
  self.info = function(id, user_key)
  {
    console.log("experiments_cache.info()");
    return self._info(id, self.get_info, user_key);
  };

  self.infos = function(ids, user_key)
  {
    console.log("experiments_cache.infos()");
    return self._info(ids, self.get_infos, user_key);
  };

  self.check_status = function(user_key, user_projects) {
    console.log("check_status", user_projects);
    var deferred = Q.defer();

    var client = xmlrpc.createClient(xmlrpc_host);

    client.methodCall('get_state', [self.collection_name, user_key], function(error, get_state_result) {
      if (error) {
        deferred.reject(error);
        return;
      }

      if (get_state_result[0] == "error") {
        deferred.reject({"error": get_state_result[1]});
        return;
      }

      var collection_state = get_state_result[1];
      var project_to_load = [];
      var project_cached = [];

      client.methodCall("list_in_use", ["projects", user_key], function (error, list_in_use_result) {
        if (error) {
          deferred.reject(error);
          return;
        }

        if (list_in_use_result[0] == "error") {
          deferred.reject({"error": value[1]});
          return;
        }

        var project_count = {};
        for (var k in list_in_use_result[1]) {
          var p_info = list_in_use_result[1][k];
          project_count[p_info[1]] = p_info[2];
        }

        for (var p in user_projects) {
          var project_name = user_projects[p]
          var project_state = self.projects_state[project_name]
          console.log(project_name + " - " + self._project_counter[project_name] + " - " + project_count[project_name]);
          if ( !(project_name in self._project_counter) || self._project_counter[project_name] != project_count[project_name]) {
            project_to_load.push(project_name);
            self._project_counter[project_name] = project_count[project_name];
          } else {
            project_cached.push(project_name);
          }
        }

        // Three Options
        // 1. All data is cached
        if (project_to_load.length == 0) {
          var request_data = [];
          self.matches++;
          console.log("Everything is cached <3.");
          process.nextTick(function() {
            for (var up in user_projects) {
              var project_name = user_projects[up];
              if (self.projects_data[project_name] !== undefined) {
                request_data = request_data.concat(self.projects_data[project_name]);
              } else {
                console.log(project_name + " data is undefined (probably it is loading)");
              }
            }
            deferred.resolve(request_data);
          });

        // 2. Some data is cached
        // 3. None data is cached
        } else {
          console.log("---------------");
          console.log(project_to_load);
          console.log(project_cached);
          console.log(user_key);
          console.log(collection_state);
          console.log("---------------");
          self.load_data(project_to_load, project_cached, user_key, collection_state).then(function(data) {
            deferred.resolve(data);
          });
        }
      });
    });

    return deferred.promise;
  },

  self.load_data = function(projects_to_load, projects_cached, user_key, collection_state) {
    console.log("load new data for " + projects_to_load.length + " projects.");

    var deferred = Q.defer();

    var client = xmlrpc.createClient(xmlrpc_host);
    var parameters = ["", "", "", "", "", "", projects_to_load, user_key];
    client.methodCall("list_experiments", parameters, function(error, list_experiments_result) {
      if (error) {
        deferred.reject(error);
        return;
      }

      if (list_experiments_result[0] == "error") {
        console.log(list_experiments_result[1]);
        deferred.reject({"error": list_experiments_result[1]});
        return;
      }

      var ids = [];
      var list_ids = list_experiments_result[1];
      console.log("processings ids");
      for (var count in list_ids) {
        if (!(list_ids[count][0] in self._id_item)) {
          ids.push(list_ids[count][0]);
        }
      }

      console.log("request info");
      client.methodCall('info', [ids, user_key], function(error, info_result) {

        if (error) {
          console.log(error);
          deferred.reject(error);
          return;
        }

        if (info_result[0] == "error") {
          console.log(info_result[1]);
          deferred.reject({"error": info_result[1]});
          return;
        }

        var pre_cached_data = {}

        for (var p in projects_to_load) {
          var project_name = projects_to_load[p];
          console.log("init array for " + project_name);
          pre_cached_data[projects_to_load[p]] = [];
        }

        var infos_data = info_result[1];
        for (var d in infos_data) {
          infos_data[d].extra_metadata = utils.experiments_extra_metadata(infos_data[d]);
          infos_data[d].biosource = infos_data[d].sample_info.biosource_name;
          self._id_item[infos_data[d]["_id"]] = infos_data[d];
        }

        for (var p in list_ids) {
          var item = self._id_item[list_ids[p][0]];
          pre_cached_data[item.project].push(item);
        }

        // set the data cache
        for (p in pre_cached_data) {
          console.log("storing: " + p + " " + collection_state + " " +   pre_cached_data[p].length);
          self.projects_state[p] = collection_state;
          self.projects_data[p] = pre_cached_data[p];
        }

        // Load the data from the cache
        var data = [];
        for (var cp in projects_to_load) {
          var cached_project_name = projects_to_load[cp];
          data = data.concat(self.projects_data[cached_project_name]);
        }

        for (cp in projects_cached) {
          var cached_project_name = projects_cached[cp];
          data = data.concat(self.projects_data[cached_project_name]);
        }

        deferred.resolve(data);
      });
    });
    return deferred.promise;
  };

  self.get = function(user_key) {
    var deferred = Q.defer();

    self.requests++;
    var client = xmlrpc.createClient(xmlrpc_host);

    var user_projects = [];
    client.methodCall("list_projects", [user_key], function(error, value) {
      if (error) {
          deferred.reject(error);
      } else {
        var projects = value[1];
        for (var project in projects) {
          user_projects.push(projects[project][1]);
        }

        deferred.resolve(
          self.check_status(user_key, user_projects)
        );
      }
    });

    return deferred.promise;
  }
};

var experiments = new ExperimentsCacheControl();

var print_length = function(data) {
  console.log(data.length);
}

experiments.get("anonymous_key").then(print_length, console.error);

module.exports = {
  "cache": experiments,
};
