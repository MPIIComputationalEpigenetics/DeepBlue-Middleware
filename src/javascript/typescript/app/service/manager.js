"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const deepblue_1 = require("./deepblue");
const composed_commands_1 = require("./composed_commands");
const composed_queries_1 = require("./composed_queries");
const regions_enrichment_1 = require("./regions_enrichment");
const genes_1 = require("./genes");
const Observable_1 = require("rxjs/Observable");
const rxjs_1 = require("rxjs");
class Manager {
    constructor() { }
    static getDeepBlueService() {
        if (this.dbs.isInitialized()) {
            return Observable_1.Observable.of(this.dbs);
        }
        let subject = new rxjs_1.Subject();
        this.dbs.init().subscribe(() => {
            subject.next(this.dbs);
            subject.complete();
        });
        return subject.asObservable();
    }
    static getComposedCommands() {
        if (this.composed_commands) {
            return Observable_1.Observable.of(this.composed_commands);
        }
        let subject = new rxjs_1.Subject();
        this.dbs.init().subscribe(() => {
            this.composed_commands = new composed_commands_1.ComposedCommands(this.dbs);
            subject.next(this.composed_commands);
            subject.complete();
        });
        return subject.asObservable();
    }
    static getComposedQueries() {
        console.log("get composed queries 1");
        if (this.composed_queries) {
            console.log("get composed queries X");
            return Observable_1.Observable.of(this.composed_queries);
        }
        let subject = new rxjs_1.Subject();
        console.log("get composed queries 2");
        this.dbs.init().subscribe(() => {
            console.log("get composed queries 3");
            this.composed_queries = new composed_queries_1.ComposedQueries(this.dbs);
            subject.next(this.composed_queries);
            subject.complete();
            console.log("COMPLETE!");
        });
        console.log("get composed queries 4");
        return subject.asObservable();
    }
    static getGenes() {
        if (this.genes) {
            return Observable_1.Observable.of(this.genes);
        }
        let subject = new rxjs_1.Subject();
        this.dbs.init().subscribe(() => {
            this.genes = new genes_1.Genes(this.dbs);
            subject.next(this.genes);
            subject.complete();
        });
        return subject.asObservable();
    }
    static getRegionsEnrichment() {
        if (this.regions_enrichment) {
            return Observable_1.Observable.of(this.regions_enrichment);
        }
        let subject = new rxjs_1.Subject();
        this.dbs.init().subscribe(() => {
            this.regions_enrichment = new regions_enrichment_1.RegionsEnrichment(this.dbs);
            subject.next(this.regions_enrichment);
            subject.complete();
        });
        return subject.asObservable();
    }
}
Manager.dbs = new deepblue_1.DeepBlueService();
Manager.composed_commands = null;
Manager.composed_queries = null;
Manager.regions_enrichment = null;
Manager.genes = null;
exports.Manager = Manager;
