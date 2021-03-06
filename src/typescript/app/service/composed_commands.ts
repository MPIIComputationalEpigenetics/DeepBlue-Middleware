import { RequestStatus } from '../domain/status';
import { Observable } from 'rxjs/Observable'
import { Subject } from "rxjs";

import { DeepBlueService } from '../service/deepblue';

import { IdName, Name, Id, FullMetadata } from '../domain/deepblue';

import {
    DeepBlueIntersection,
    DeepBlueFilter,
    DeepBlueOperation,
    DeepBlueResult,
    DeepBlueTiling,
    DeepBlueOperationArgs,
    DeepBlueDataParameter,
    DeepBlueResultError,
    DeepBlueFilterParameters,
    DeepBlueAggregate,
    DeepBlueFlank,
    DeepBlueExtend,
    DeepBlueError,
    DeepBlueFilterMotifParameters
} from '../domain/operations';
import { IOperation } from 'app/domain/interfaces';

export class ComposedCommands {
    constructor(private deepBlueService: DeepBlueService) { }

    selectMultipleExperiments(experiments: Name[], status: RequestStatus): Observable<DeepBlueOperation[]> {

        let total = 0;
        let observableBatch: Observable<DeepBlueOperation>[] = [];

        experiments.forEach((experiment: Name) => {
            observableBatch.push(this.deepBlueService.selectExperiment(experiment, status));
        });

        return Observable.forkJoin(observableBatch);
    }

    intersectWithSelected(current_operations: DeepBlueOperation[], selected_data: DeepBlueOperation[],
        status: RequestStatus): Observable<DeepBlueIntersection[]> {

        let observableBatch: Observable<DeepBlueIntersection>[] = [];

        current_operations.forEach((current_op) => {
            selected_data.forEach((data) => {
                let o = this.deepBlueService.intersection(current_op, data, status);
                observableBatch.push(o);
            });
        });

        return Observable.forkJoin(observableBatch);
    }

    filterWithSelected(current_operations: DeepBlueOperation[], filter: DeepBlueFilterParameters,
        status: RequestStatus): Observable<DeepBlueOperation[]> {

        let observableBatch: Observable<DeepBlueOperation>[] = [];

        current_operations.forEach((current_op) => {
            let o = this.deepBlueService.filter_regions(current_op, filter, status);
            observableBatch.push(o);
        });

        return Observable.forkJoin(observableBatch);
    }

    countRegionsBatch(query_ops: DeepBlueOperation[], status: RequestStatus): Observable<DeepBlueResult[]> {
        let observableBatch: Observable<DeepBlueResult>[] = [];

        query_ops.forEach((op_exp, key) => {
            let o: Observable<DeepBlueResult> = new Observable((observer) => {
                this.deepBlueService.count_regions(op_exp, status).subscribe((result) => {
                    status.addPartialData(result);
                    observer.next(result);
                    observer.complete();
                })
            });

            observableBatch.push(o);
        });

        return Observable.forkJoin(observableBatch);
    }

    applyFilter(current_operations: DeepBlueOperation[], filters: DeepBlueFilterParameters[], status: RequestStatus): Observable<DeepBlueOperation[]> {
        if (filters.length == 0) {
            return Observable.of(current_operations);
        } else {
            let filter = filters.shift();

            let subject = new Subject<DeepBlueFilter[]>();
            this.filterWithSelected(current_operations, filter, status).subscribe((new_operation: DeepBlueOperation[]) => {
                return this.applyFilter(new_operation, filters, status).subscribe((queries_filtered: DeepBlueFilter[]) => {
                    subject.next(queries_filtered);
                    subject.complete();
                });
            });

            return subject.asObservable();
        }
    }

    countOverlaps(data_query_id: DeepBlueOperation[], experiments_name: Name[], filters: DeepBlueFilterParameters[], status: RequestStatus): Observable<DeepBlueResult[]> {
        let total = data_query_id.length * experiments_name.length * 3;
        status.reset(total);

        let response: Subject<DeepBlueResult[]> = new Subject<DeepBlueResult[]>();

        status.setStep("Selecting experiments regions");

        this.selectMultipleExperiments(experiments_name, status).subscribe((selected_experiments: DeepBlueOperation[]) => {
            status.setStep("Overlaping regions");

            this.applyFilter(selected_experiments, filters, status).subscribe((filtered_data: DeepBlueFilter[]) => {
                this.intersectWithSelected(data_query_id, filtered_data, status).subscribe((overlap_ops: DeepBlueOperation[]) => {
                    status.setStep("Intersecting regions");

                    this.countRegionsBatch(overlap_ops, status).subscribe((datum: DeepBlueResult[]) => {
                        setTimeout(() => {
                            response.next(datum);
                            response.complete();
                        });
                    });
                });
            });
        });

        return response.asObservable();
    }

    countGenesOverlaps(data_query_id: DeepBlueOperation[], gene_model: Name, filters: any[], status: RequestStatus): Observable<DeepBlueResult[][]> {
        var start = new Date().getTime();

        let total = data_query_id.length * data_query_id.length * 3;
        status.reset(total);

        filters.unshift({});

        status.setStep("Selecting genes regions");

        return this.deepBlueService.selectGenes(gene_model, status).flatMap((selected_genes: DeepBlueOperation) => {
            let observableCounts = new Array<Observable<DeepBlueResult[]>>();

            for (let filter of filters) {
                let modificator = Observable.of(selected_genes);
                if (filter.type == "flank") {
                    modificator = this.deepBlueService.flank(selected_genes, filter.start, filter.length, status)
                } else if (filter.type == "extend") {
                    modificator = this.deepBlueService.extend(selected_genes, filter.length, filter.direction, status)
                }

                let obs = modificator.flatMap((modified_genes) => {
                    return this.intersectWithSelected(data_query_id, [modified_genes], status).flatMap((overlap_ids: DeepBlueOperation[]) =>
                        this.countRegionsBatch(overlap_ids, status)
                    );
                });
                observableCounts.push(obs);
            }
            return Observable.forkJoin(observableCounts);
        });
    }

    loadQuery(query_id: Id, status: RequestStatus): Observable<IOperation> {

        return this.deepBlueService.info(query_id, status).map((fullMetadata: FullMetadata) => {
            let type = fullMetadata.type();
            let id = fullMetadata.id;
            let name = fullMetadata.name;

            let content;
            if (name) {
                content = new DeepBlueDataParameter(new Name(name));
            } else {
                content = new DeepBlueOperationArgs(fullMetadata.get('args'));
            }

            switch (type) {
                case "genes_select":
                case 'find_motif':
                case "input_regions": {
                    return Observable.of(new DeepBlueOperation(content, id, type));
                }

                case "annotation_select": {
                    let ann_name = fullMetadata.get('args')['annotation'];
                    return this.deepBlueService.nameToId(ann_name, "annotations", status).flatMap((idNames: IdName[]) => {
                        return Observable.of(new DeepBlueOperation(new DeepBlueDataParameter(idNames[0]), id, "select_annotations"));
                    })
                }

                case "experiment_select":
                    let exp_name = fullMetadata.get('args')['experiment_name'];
                    return this.deepBlueService.nameToId(exp_name, "experiments", status).flatMap((idNames: IdName[]) => {
                        return Observable.of(new DeepBlueOperation(new DeepBlueDataParameter(idNames[0]), id, "select_experiments"));
                    })

                case "filter":
                case 'filter_by_motif': {
                    let filter_parameters;
                    if (type == "filter") {
                        filter_parameters = DeepBlueFilterParameters.fromObject(fullMetadata['values']['args']);
                    } else {
                        filter_parameters = DeepBlueFilterMotifParameters.fromObject(fullMetadata['values']['args']);
                    }

                    let _query = new Id(fullMetadata.get('args')['query']);
                    return this.loadQuery(_query, status).flatMap((op) => {
                        return Observable.of(new DeepBlueFilter(op, filter_parameters, query_id));
                    });
                }

                case "tiling": {
                    let genome = fullMetadata.get('args')['genome'];
                    let size = Number(fullMetadata.get('args')['size']);
                    let chromosomes = fullMetadata.get('args')['chromosomes'];
                    return Observable.of(new DeepBlueTiling(size, genome, chromosomes, id));
                }

                case "intersect":
                case "overlap": {
                    let data = new Id(fullMetadata.get('args')['qid_1']);
                    let filter = new Id(fullMetadata.get('args')['qid_2']);

                    return Observable.forkJoin([
                        this.loadQuery(data, status),
                        this.loadQuery(filter, status)
                    ]).map(([op_data, op_filter]) => {
                        return new DeepBlueIntersection(op_data, op_filter, true, id);
                    })
                }

                case "aggregate": {
                    let data_id = new Id(fullMetadata.get('args')['data_id']);
                    let ranges_id = new Id(fullMetadata.get('args')['ranges_id']);
                    let field = fullMetadata.get('args')['field'];

                    return Observable.forkJoin([
                        this.loadQuery(data_id, status),
                        this.loadQuery(ranges_id, status)
                    ]).map(([op_data, op_ranges]) => {
                        return new DeepBlueAggregate(op_data, op_ranges, field, id);
                    });
                }

                case "flank":
                case 'extend': {
                    let args = DeepBlueOperationArgs.fromObject(fullMetadata.get('args'));
                    let _data = new Id(fullMetadata.get('args')['query_id']);
                    return this.loadQuery(_data, status).flatMap((op) => {
                        if (type == "flank") {
                            return Observable.of(new DeepBlueFlank(op, args, query_id));
                        } else if (type == "extend") {
                            return Observable.of(new DeepBlueExtend(op, args, query_id));
                        } else {
                            console.log("Unknow type", type);
                            return Observable.of(null);
                        }
                    });
                }

                default: {
                    console.error("Invalid type ", type, " at ", JSON.stringify(fullMetadata));
                    return Observable.of(new DeepBlueOperation(new DeepBlueDataParameter(name), id, type));
                }
            }
        }).flatMap((o) => o);
    }

    private handleError(error: Response | any) {
        let errMsg: string;
        if (error instanceof Response) {
            const body = error.json() || '';
            errMsg = JSON.stringify(body);
        } else {
            errMsg = error.message ? error.message : error.toString();
        }
        return Observable.throw(errMsg);
    }
}
