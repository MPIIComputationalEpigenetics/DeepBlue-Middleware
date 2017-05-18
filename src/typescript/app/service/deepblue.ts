import { RequestStatus } from '../domain/status';
import { Utils } from './utils';
import { Observable } from "rxjs/Observable";
import { Subscriber } from "rxjs/Subscriber";
import { Subject } from "rxjs/Subject";

import { DataCache, MultiKeyDataCache } from '../service/cache';

import { FullGeneModel, FullMetadata, GeneModel, IdName, Name } from '../domain/deepblue';
import {
  DeepBlueIntersection,
  DeepBlueMiddlewareOverlapResult,
  DeepBlueOperation,
  DeepBlueRequest,
  DeepBlueResult,
  DeepBlueSelectData
} from '../domain/operations';

import 'rxjs/Rx';

import * as xmlrpc from 'xmlrpc';

let settings = require('../../../settings');
let xmlrpc_host = settings.xmlrpc_host();

class Command {
  constructor(public name: string, public parameters: Object[]) { }

  build_xmlrpc_request(values: Object): Object[] {

    let xmlrpc_request_parameters: Object[] = [];

    for (let pos in this.parameters) {
      var parameter = this.parameters[pos];
      var parameter_name = parameter[0];
      var parameter_type = parameter[1];
      var multiple = parameter[2];

      if (parameter_name in values) {
        var raw_value = values[parameter_name];
        if (parameter_type == "string") {
          xmlrpc_request_parameters.push(raw_value);
        } else if (parameter_type == "int") {
          xmlrpc_request_parameters.push(parseInt(raw_value));
        } else if (parameter_type == "double") {
          xmlrpc_request_parameters.push(parseFloat(raw_value));
        } else if (parameter_type == "struct") {
          var extra_metadata = JSON.parse(raw_value);
          xmlrpc_request_parameters.push(extra_metadata);
        } else if (parameter_type == "boolean") {
          var bool_value = raw_value == "true";
          xmlrpc_request_parameters.push(bool_value);
        } else {
          console.error("Internal error: Unknown variables type ", parameter_type);
          return;
        }
      } else {
        if (parameter_name == "user_key") {
          xmlrpc_request_parameters.push("anonymous_key");
        } else {
          xmlrpc_request_parameters.push(null);
        }
      }
    }
    return xmlrpc_request_parameters;
  }

  makeRequest(parameters: Object): Observable<string[]> {
    let xmlrpc_parameters = this.build_xmlrpc_request(parameters);
    var client = xmlrpc.createClient(xmlrpc_host);
    var methodCall = Observable.bindCallback(client.methodCall);

    let subject: Subject<string[]> = new Subject<string[]>();

    let isProcessing = false;


    let timer = Observable.timer(0, Utils.rnd(0, 250)).do(() => {
      if (isProcessing) {
        return;
      }
      isProcessing = true;
      client.methodCall(this.name, xmlrpc_parameters, (err: Object, value: any) => {
        if (err) {
          console.error(this.name, xmlrpc_parameters, err);
          isProcessing = false;
          return;
        }
        subject.next(value);
        subject.complete();
        isProcessing = false;
        timer.unsubscribe();
      });
    }).subscribe();

    return subject.asObservable();
  }
}

export class DeepBlueService {

  private _commands: Map<string, Command>;

  IdObjectCache = new DataCache<IdName, FullMetadata>();

  idNamesQueryCache = new DataCache<Name, DeepBlueOperation>();


  intersectsQueryCache = new MultiKeyDataCache<DeepBlueOperation, DeepBlueIntersection>();

  requestCache = new DataCache<DeepBlueOperation, DeepBlueRequest>();
  resultCache = new DataCache<DeepBlueRequest, DeepBlueResult>()


  constructor() { }

  public init(): Observable<boolean> {
    let client = xmlrpc.createClient(xmlrpc_host);
    let subject: Subject<boolean> = new Subject<boolean>();

    client.methodCall("commands", [], (error: Object, value: any) => {
      let commands = value[1];
      for (let command_name in commands) {
        let command = new Command(command_name, commands[command_name]["parameters"]);
        commands[command_name] = command;
      }
      this._commands = commands;

      subject.next(true);
      subject.complete();
    });

    return subject.asObservable();
  }

  execute(command_name: string, parameters: Object, status: RequestStatus): Observable<[string | any]> {

    let command: Command = this._commands[command_name];
    return command.makeRequest(parameters).map((body: string[]) => {
      let command_status: string = body[0];
      let response: any = body[1] || "";
      if (command_status === "error") {
        console.error(command_name, parameters, response);
      }
      status.increment();
      return [status, response];
    });
  }

  selectExperiment(experiment: Name, status: RequestStatus): Observable<DeepBlueOperation> {
    if (!experiment) {
      return Observable.empty<DeepBlueOperation>();
    }

    let cached_operation = this.idNamesQueryCache.get(experiment);
    if (cached_operation) {
      status.increment();
      return Observable.of(cached_operation);
    }

    let params: Object = new Object();
    params["experiment_name"] = experiment.name;

    return this.execute("select_experiments", params, status).map((response: [string, any]) => {
      status.increment();
      return new DeepBlueSelectData(experiment, response[1], "select_experiment");
    }).do((operation) => {
      this.idNamesQueryCache.put(experiment, operation);
    }).catch(this.handleError);
  }

  selectGenes(gene_model_name: Name, status: RequestStatus): Observable<DeepBlueOperation> {
    let cached_operation = this.idNamesQueryCache.get(gene_model_name);
    if (cached_operation) {
      status.increment();
      return Observable.of(cached_operation);
    }

    const params: Object = new Object();
    params['gene_model'] = gene_model_name.name;

    return this.execute("select_genes", params, status).map((response: [string, any]) => {
      status.increment();
      return new DeepBlueSelectData(gene_model_name, response[1], 'select_genes');
    }).do((operation) => {
      this.idNamesQueryCache.put(gene_model_name, operation);
    }).catch(this.handleError);
  }


  intersection(query_data_id: DeepBlueOperation, query_filter_id: DeepBlueOperation, status: RequestStatus): Observable<DeepBlueIntersection> {

    let cache_key = [query_data_id, query_filter_id];

    let cached_intersection = this.intersectsQueryCache.get(cache_key);
    if (cached_intersection) {
      status.increment();
      return Observable.of(cached_intersection);
    }

    let params = {};
    params["query_data_id"] = query_data_id.queryId();
    params["query_filter_id"] = query_filter_id.queryId();
    return this.execute("intersection", params, status)
      .map((response: [string, any]) => {
        return new DeepBlueIntersection(query_data_id, query_filter_id, response[1])
      })

      .do((operation: DeepBlueIntersection) => this.intersectsQueryCache.put(cache_key, operation))

      .catch(this.handleError);
  }

  count_regions(op_exp: DeepBlueOperation, status: RequestStatus): Observable<DeepBlueResult> {

    if (this.requestCache.get(op_exp)) {
      status.increment();
      let cached_result = this.requestCache.get(op_exp);
      return this.getResult(cached_result, status);

    } else {
      let params = new Object();
      params["query_id"] = op_exp.queryId();

      let request: Observable<DeepBlueResult> = this.execute("count_regions", params, status).map((data: [string, any]) => {
        let request = new DeepBlueRequest(op_exp, data[1], "count_regions");
        this.requestCache.put(op_exp, request);
        return request;
      }).flatMap((request_id) => {
        return this.getResult(request_id, status);
      })

      return request;
    }
  }

  calculate_enrichment(data: DeepBlueOperation, gene_model_name: Name, status: RequestStatus): Observable<DeepBlueResult> {
    const params: Object = new Object();
    params['query_id'] = data.queryId();
    params['gene_model'] = gene_model_name.name;

    let request: Observable<DeepBlueResult> = this.execute("calculate_enrichment", params, status).map((response: [string, any]) => {
      status.increment();
      return new DeepBlueRequest(data, response[1], 'calculate_enrichment');
    }).flatMap((request_id) => {
      console.log(request_id);
      return this.getResult(request_id, status);
    }).catch(this.handleError);

    return request;
  }

  list_gene_models(status: RequestStatus): Observable<IdName[]> {
    const params: Object = new Object();

    return this.execute("list_gene_models", params, status).map((response: [string, any]) => {
      const data = response[1] || [];
      return data.map((value) => {
        return new GeneModel(value);
      }).sort((a: IdName, b: IdName) => a.name.localeCompare(b.name));
    });
  }

  info(id_name: IdName, status: RequestStatus): Observable<FullMetadata> {

    let object = this.IdObjectCache.get(id_name);
    if (object) {
      console.log("info cache found: ", object);
      status.increment();
      return Observable.of(object);
    }

    return this.execute("info", id_name, status).map((response: [string, any]) => {
      console.log("info stuff:", response[1]);
      return new FullMetadata(response[1][0]);
    })
      .do((info_object: FullMetadata) => {
        console.log("cacgubg::m", info_object);
        this.IdObjectCache.put(id_name, info_object)
      });
  }

  infos(id_names: IdName[], status: RequestStatus): Observable<FullMetadata[]> {
    let total = 0;
    let observableBatch: Observable<FullMetadata>[] = [];

    id_names.forEach((id_name: IdName) => {
      observableBatch.push(this.info(id_name, status));
    });

    return Observable.forkJoin(observableBatch);
  }

  getResult(op_request: DeepBlueRequest, status: RequestStatus): Observable<DeepBlueResult> {

    let result = this.resultCache.get(op_request);
    if (result) {
      status.increment();
      return Observable.of(result);
    }

    let params = new Object();
    params["request_id"] = op_request.request_id;

    let pollSubject = new Subject<DeepBlueResult>();
    let client = xmlrpc.createClient(xmlrpc_host);

    let isProcessing = false;

    let timer = Observable.timer(0, Utils.rnd(0, 500)).do(() => {
      if (isProcessing) {
        return;
      }
      isProcessing = true;
      client.methodCall("get_request_data", [op_request.request_id, 'anonymous_key'], (err: Object, value: any) => {
        if (err) {
          console.error(err);
          isProcessing = false;
          return;
        }

        if (value[0] === "okay") {
          status.increment();
          let op_result = new DeepBlueResult(op_request, value[1]);
          this.resultCache.put(op_request, op_result);
          timer.unsubscribe();
          console.log(op_result);
          pollSubject.next(op_result);
          pollSubject.complete();
        } else {
          isProcessing = false;
        }

      });
    }).subscribe();

    return pollSubject.asObservable();
  }

  private handleError(error: Response | any) {
    let errMsg: string;
    errMsg = error.message ? error.message : error.toString();
    console.error(errMsg);
    return Observable.throw(errMsg);
  }

}
