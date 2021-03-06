import { RequestStatus } from '../domain/status';
import { DeepBlueResult, DeepBlueOperation, DeepBlueFilter, DeepBlueFilterParameters } from '../domain/operations';
import { DeepBlueService } from "../service/deepblue";
import { IdName, IdNameCount, FullMetadata, Name } from "../domain/deepblue";
import { Observable } from "rxjs/Observable";
import { Subject } from "rxjs";


export class RegionsEnrichment {
  chromatinCache = new Map<string, [string, any[]]>();

  constructor(private deepBlueService: DeepBlueService) { }

  private getChromatinStates(request_status: RequestStatus, genome: string): Observable<DeepBlueResult> {
    return this.deepBlueService.select_regions_from_metadata(genome, "peaks", "Chromatin State Segmentation",
      null, null, null, null, request_status).flatMap((op: DeepBlueOperation) => {
        return this.deepBlueService.distinct_column_values(op, "NAME", request_status)
      })
  }

  private buildChromatinStatesQueries(request_status: RequestStatus, genome: string): Observable<[string, [string, [string, string, string, string, string][]][]]> {
    let response = new Subject<[string, [string, [string, string, string, string, string][]][]]>();

    if (this.chromatinCache.has(genome)) {
      return Observable.of(this.chromatinCache.get(genome));
    }

    Observable.forkJoin([
      this.getChromatinStates(request_status, genome),
      this.deepBlueService.list_experiments_full(request_status, "peaks", "Chromatin State Segmentation", genome)
    ]).subscribe((subs: any[]) => {

      let states: { [key: string]: number } = (<DeepBlueResult>subs[0]).resultAsDistinct()
      let state_names = Object.keys(states);
      let experiments: FullMetadata[] = subs[1];

      let exp_states_obs = experiments.map((experiment) => {
        return this.deepBlueService.selectExperiment(experiment, request_status)
          .flatMap((exp_op: DeepBlueOperation) => {
            return this.deepBlueService.query_cache(exp_op, request_status)
          })
          .flatMap((exp_cached: DeepBlueOperation) => {
            let filter_queries = new Array<Observable<DeepBlueFilter>>();
            for (let state of state_names) {
              let filter = new DeepBlueFilterParameters("NAME", "==", state, "string");
              let filter_op = this.deepBlueService.filter_regions(exp_cached, filter, request_status);
              filter_queries.push(filter_op);
            }

            return Observable.forkJoin(filter_queries).map((filters) => {
              let exp_filter_id = new Array<string[]>();

              for (let filter of filters) {
                let exp_name = filter.mainOperation().name();
                let filter_name = (<DeepBlueFilterParameters>filter._params).value;
                let q_id = filter.id().id;
                exp_filter_id.push([experiment.id.id, exp_name, experiment.biosource(), filter_name, experiment.project(), q_id]);
              }

              return exp_filter_id;
            })
          })
      })

      Observable.forkJoin(exp_states_obs).subscribe((filters) => {
        let states: { [key: string]: [string, string, string, string, string][] } = {};


        for (let exp_filters of filters) {
          for (let filter of exp_filters) {
            if (!(filter[3] in states)) {
              states[filter[3]] = new Array<[string, string, string, string, string]>();
            }
            // filter_name is the key, values are: exp_id, exp_name, biosource, project, and query id

            states[filter[3]].push([filter[0], filter[1], filter[2], filter[4], filter[5]]);
          }
        }

        let arr_filter: [string, [string, string, string, string, string][]][] = Object.keys(states).map((state) => {
          return <[string, [string, string, string, string, string][]]>[state, states[state]]
        });


        let result : [string, [string, [string, string, string, string, string][]][]] = ["Chromatin States Segmentation", arr_filter]

        this.chromatinCache.set(genome, result)
        response.next(result);
        response.complete();
      });
    });

    return response.asObservable();
  };

  private listExperiments(request_status: RequestStatus, epigenetic_mark: string, genome: string): Observable<[string, any[]]> {
    return this.deepBlueService.list_experiments_full(request_status, "peaks", epigenetic_mark, genome).map(((experiments: FullMetadata[]) =>
      <[string, [string, string, string, string][]]>      
      [epigenetic_mark, experiments.map((experiment: FullMetadata) =>
        [experiment.id.id, experiment.name, experiment.biosource(), experiment.project()]
      )]
    ));
  }


  private listExperimentsMany(request_status: RequestStatus, epigenetic_marks: string[], genome: string): Observable<Array<[string, any[]]>> {
    let observableBatch: Observable<[string, any[]]>[] = [];
    epigenetic_marks.forEach((epigenetic_mark: string) => {
      let o;
      if (epigenetic_mark == "Chromatin State Segmentation") {
        o = this.buildChromatinStatesQueries(request_status, genome);
      } else {
        o = this.listExperiments(request_status, epigenetic_mark, genome);
      }
      observableBatch.push(o);
    });
    return Observable.forkJoin(observableBatch);

  }

  buildFullDatabases(request_status: RequestStatus, genome: string): Observable<[string, string[]][]> {
    let pollSubject = new Subject<[string, string[]][]>();

    this.deepBlueService.collection_experiments_count(request_status,    "epigenetic_marks", "peaks", genome).subscribe((ems: IdNameCount[]) => {
      let histone_marks_names = ems.map((id_name: IdNameCount) => id_name.name);
      this.listExperimentsMany(request_status, histone_marks_names, genome).subscribe((dbs: [string, string[]][]) => {
        pollSubject.next(dbs.filter((em) => {
          return em && em[1].length > 0
        }));
        pollSubject.complete();
      })
    });

    return pollSubject.asObservable();
  }

  enrichRegionsOverlap(data_query_id: DeepBlueOperation[], genome: string, universe_id: string, datasets: Object, status: RequestStatus): Observable<DeepBlueResult[]> {
    var start = new Date().getTime();

    let total = data_query_id.length * data_query_id.length * 3;
    status.reset(total);

    let response: Subject<DeepBlueResult[]> = new Subject<DeepBlueResult[]>();

    let observableBatch: Observable<DeepBlueResult>[] = [];

    data_query_id.forEach((current_op) => {
      let o = this.deepBlueService.enrich_regions_overlap(current_op, genome, universe_id, datasets, status);
      observableBatch.push(o);
    });

    return Observable.forkJoin(observableBatch);
  }

  enrichRegionsFast(data_query_id: DeepBlueOperation, genome: string, status: RequestStatus): Observable<DeepBlueResult[]> {

    let em_observers = this.deepBlueService.collection_experiments_count(status, "epigenetic_marks", "peaks", genome);
    let bs_observers = this.deepBlueService.collection_experiments_count(status, "biosources", "peaks", genome);

    let o = Observable.forkJoin([
      em_observers,
      bs_observers
    ]).map((exp_infos: IdNameCount[][]) => {
      let epigenetic_marks = exp_infos[0];
      let biosources = exp_infos[1];

      let key = "";
      let values = [];

      if (epigenetic_marks.length > biosources.length) {
        key = "epigenetic_mark";
        values = epigenetic_marks;
      } else {
        key = "biosource";
        values = biosources;
      }

      let observableBatch: Observable<DeepBlueResult>[] = [];

      status.reset(values.length * 2);

      values.forEach((em: IdName) => {
        let o: Observable<DeepBlueResult> = new Observable((observer) => {
          let filter = {};
          filter[key] = em.name;
          filter["technique"] = "chip-seq";
          this.deepBlueService.enrich_regions_fast(data_query_id, genome, filter, status).subscribe((result: DeepBlueResult) => {
            status.mergePartialData(result.resultAsEnrichment());
            observer.next(result);
            observer.complete();
          });
        });
        observableBatch.push(o);
      });

      return Observable.forkJoin(observableBatch);
    });

    return o.flatMap((results: Observable<DeepBlueResult[]>) => results);
  }


  enrichRegionsGoTerms(data_query_id: DeepBlueOperation[], gene_model: Name, status: RequestStatus): Observable<DeepBlueResult[]> {
    let total = data_query_id.length * data_query_id.length * 3;
    status.reset(total);

    let response: Subject<DeepBlueResult[]> = new Subject<DeepBlueResult[]>();

    let observableBatch: Observable<DeepBlueResult>[] = [];

    data_query_id.forEach((current_op) => {
        let o : Observable<DeepBlueResult> = new Observable((observer) => {
          this.deepBlueService.enrich_regions_go_terms(current_op, gene_model, status).subscribe((result: DeepBlueResult) => {
            status.mergePartialData(result.resultAsEnrichment());
            observer.next(result);
            observer.complete();
          });
        });
        observableBatch.push(o);
    });

    return Observable.forkJoin(observableBatch);
}

}