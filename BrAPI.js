(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
    typeof define === 'function' && define.amd ? define(factory) :
    (global.BrAPI = factory());
}(this, (function () { 'use strict';

class NodeFrayError extends Error {
    constructor(message) {
        super(message);
        console.log("***Error Occured During BrAPI.js Node Creation*** (Check provided user callback)");
        console.log(message);
        this.name = "NodeFrayError";
    }
}

class DatumWrapper {
    constructor(val,key){
        this.val = val;
        this.key = key;
    }
    map(result){
        return Promise.resolve(result).then(r=>{
            return new DatumWrapper(r,this.key);
        });
    }
    map_key(result){
        return Promise.resolve(result).then(r=>{
            return new DatumWrapper(this.val,r);
        });
    }
    fork(results){
        return Promise.resolve(results).then(rs=>{
            return rs.map((result,i)=>{
                return new DatumWrapper(result,this.key+","+i);
            })
        });
    }
}

class DatumJoin {
    constructor(key,thread_count){
        this.key = key;
        this.thread_count = thread_count;
        this.joined = [];
        for (var i = 0; i < this.thread_count; i++) {
            this.joined.push(DatumJoin.placeHolder);
        }
        this.promise = new Promise(resolve=>this.resolve=resolve);
    }
    join(value,thread_index){
        this.joined[thread_index] = value;
        if(this.joined.every(j=>j!==DatumJoin.placeHolder)){
            this.resolve(new DatumWrapper(this.joined,this.key));
        }
    }
    complete(){
        this.resolve(new DatumWrapper(this.joined.map(d=>d===DatumJoin.placeHolder?undefined:d),this.key));
    }
}
DatumJoin.placeHolder = {};

class DatumJoinMap {
    constructor(thread_count){
        this.thread_count = thread_count;
        this.keymap = {};
    }
    join(datum,thread_index){
        if(this.keymap[datum.key]!=undefined){
            this.keymap[datum.key].join(datum.val,thread_index);
            return Promise.resolve([]);
        } 
        else {
            this.keymap[datum.key] = new DatumJoin(datum.key,this.thread_count);
            this.keymap[datum.key].join(datum.val,thread_index);
            return this.keymap[datum.key].promise;
        }
    }
    complete(){
        for (var key in this.keymap) {
            if (this.keymap.hasOwnProperty(key)) {
                this.keymap[key].complete();
            }
        }
    }
}

class ThreadNode {
    constructor() {
        this._filaments = []; // Array of Promises for Arrays of Promises etc

        this._state = {
            'source':{
                'committed':false,
                'initiator':null
            },
            'status':"PENDING"
        };
        this._control = {'flatten':undefined};
        this._state.complete = new Promise(resolve => {
            this._control.flatten = ()=>{                
                this._flatten_filaments(this._filaments).then(data=>{
                    this._state.status = "RESOLVED";
                    resolve(data);
                });
            };
        });

        this._each_callbacks = [];
    }

    _connect(initiator){
        if(this._state.source.committed){
            throw new Error("ThreadNode cannot have two data sources.");
        } else {
            this._state.source.committed = true;
            this._state.source.initiator = initiator?(initiator._state || null):null;
            return {
                'send':(fray)=>{ // add datum or datum promises
                    var filament = Promise.resolve(fray).then(fray_data=>{
                        return fray_data.map(datum=>Promise.resolve(datum));
                    });
                    this._filaments.push(filament);
                    this._each_callbacks.forEach(ec=>ec(filament));
                },
                'finish':()=> this._control.flatten() // call when last filament has been frayed, locks in filament count.
            }
        }
    }
    
    _outputNode(){
        return new ThreadNode();
    }

    all(c){
        this._state.complete.then(data=>{
            try {
                return c(data.map(d=>d.val));
            } catch (e) {
                new NodeFrayError(e);
            }
        });
        return this;
    }

    each(c){
        let fc = fray_data=>fray_data.forEach(d=>{
            Promise.resolve(d).then(datum=>{
                try {
                    return (datum instanceof Array) ? fc(datum) : c(datum.val,datum.key);
                } catch (e) {
                    new NodeFrayError(e);
                    return []
                }
            });
        });
        let ec = filament=>filament.then(fc);
        this._filaments.forEach(ec);
        this._each_callbacks.push(ec);
        return this;
    }
    
    _fray(fray_func){
        let frayed = this._outputNode();
        let edge = frayed._connect(this);
        let fc = fray_data=>fray_data.map(d=>{
            return Promise.resolve(d).then(datum=>{
                if(datum instanceof Array) return fc(datum);
                var returnVal;
                try {
                    returnVal = fray_func(datum,edge.send);
                } catch (e) {
                    returnVal = new DatumWrapper(new NodeFrayError(e), datum.key);
                } finally {
                    return returnVal;
                }
            });
        });
        let ec = filament=>filament.then(fc);
        this._filaments.forEach(ec);
        this._each_callbacks.push(ec);
        this._state.complete.then( ()=> edge.finish() );
        return frayed;
    }
    
    fork(c){
        return this._fray((datum,send)=>send([datum.fork(c(datum.val,datum.key))]))
    }
    map(c){
        return this._fray((datum,send)=>send([datum.map(c(datum.val,datum.key))]))
    }
    keys(c){
        return this._fray((datum,send)=>send([datum.map_key(c(datum.val,datum.key)||datum.key)]))
    }
    filter(c){
        return this._fray((datum,send)=>send(c(datum.val,datum.key)?[datum.map(datum.val)]:[]))
    }
    
    reduce(reduce_func){
        let reduced = this._outputNode();
        let edge = reduced._connect(this);
        this.all( (data) => { 
            try {
                //data.reduce(reduce_func).forEach(d=>edge.send([this._wrap_datum(d)]));
		data.reduce(reduce_func,[]);
                edge.send([this._wrap_datum(data)]);
            } catch (e) {
                edge.send([new DatumWrapper(new NodeFrayError(e), "0?")]);
            } finally {
                edge.finish();
            }
        } );
        return reduced;
    }
    
    join(OtherThreadNode){
        let otherThreads = Array.prototype.slice.call(arguments);
        let inputThreads = [this].concat(otherThreads);
        
        let joinmap = new DatumJoinMap(inputThreads.length);
        
        let joined = this._outputNode();
        let edge = joined._connect(this);
        let fci = i => fray_data => fray_data.map(d=>{
            return Promise.resolve(d).then(datum=>{
                if(datum instanceof Array) return fci(i)(datum);
                return joinmap.join(datum,i);
            })
        });
        let eci = i => filament=>edge.send(filament.then(fci(i)));
        inputThreads.forEach((thread,i)=>{
            thread._filaments.forEach(eci(i));
            thread._each_callbacks.push(eci(i));
        });
        Promise.all(inputThreads.map(t=>t._state.complete)).then(()=>{
            joinmap.complete();
            edge.finish();
        });
        return joined;
    }
    
    _flatten_filaments(arr){
        return Promise.all(arr).then(res_arr=>{
            return Promise.all(res_arr.map(d=>{
                return Promise.resolve(d).then(d=>(d instanceof Array)?this._flatten_filaments(d):[d])
            })).then(peices=>peices.reduce((a, v)=>a.concat(v),[]))
        })
    }
    
    _wrap_datum(datum,key){
        if(this._datum_key_next==undefined) this._datum_key_next = 0;
        return Promise.resolve(datum).then(d=>{
            return new DatumWrapper(d,""+(this._datum_key_next++));
        })
    }
}

class EmptyThreadNode extends ThreadNode {
    constructor(){
        super(arguments);
        var ownInput = this._connect(null);
        ownInput.send([this._wrap_datum(null)]);
        ownInput.finish();
    }
    
    data(arr){
        let created = this._outputNode();
        let edge = created._connect(this);
        Promise.resolve(arr).then(data=>{
            data.forEach(item=>edge.send([this._wrap_datum(item)]));
            edge.finish();
        });
        return created;
    }
    
}

// function randDelay(p){
//     return Promise.resolve(p).then(d=>(new Promise(r=>{
//         setTimeout(()=>r(d),Math.floor(Math.random() * Math.floor(5000)))
//     })));
// }
// 
// var mye = (new EmptyThreadNode()).data([ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
//     .map(randDelay)
//     .keys(d=>`Key{${d}}`)
//     .each((d,key)=>console.log(d,"initial",key))
//     .all(d=>console.log("DONE::initial",d));
// 
// var j1 = mye.map(d=>d*2)
//     .map(randDelay)
//     .each((d,key)=>console.log(d,"j1",key))
//     .all(d=>console.log("DONE::j1",d));
// 
// var j2 = mye.map(d=>d*3)
//     .map(randDelay)
//     .each((d,key)=>console.log(d,"j2",key))
//     .all(d=>console.log("DONE::j2",d));
// 
// var j3 = mye.map(d=>d*5)
//     .map(randDelay)
//     .each((d,key)=>console.log(d,"j3",key))
//     .all(d=>console.log("DONE::j3",d));
// 
// var join = j1.join(j2,j3)
//     .each((d,key)=>console.log(d,"join",key))
//     .all(d=>console.log("DONE::join",d));

/** `GET /allelematrices`
 * @alias BrAPINode.prototype.allelematrices
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function allelematrices (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/allelematrices',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /allelematrices-search`(>=v1.2) or `POST /allelematrix-search`(<v1.2)
* @alias BrAPINode.prototype.allelematrices_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function allelematrices_search(params,behavior){
    var call = {
        'defaultMethod': 'post',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    
    if (this.version.predates("v1.2")){
        call.urlTemplate = "/allelematrix-search";
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.2"
        });
    } else {
        call.urlTemplate = "/allelematrices-search";
        this.version.check(call.urlTemplate,{
            introduced:"v1.2"
        });
    }
    
    return this.simple_brapi_call(call);
}

/** `GET /attributes`
 * @alias BrAPINode.prototype.attributes
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function attributes (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/attributes',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /attributes`
* @alias BrAPINode.prototype.attributes_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function attributes_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/attributes',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `GET /attributes/{attributeDbId}`
 * @alias BrAPINode.prototype.attributes_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.attributeDbId attributeDbId
 * @return {BrAPI_Behavior_Node}
 */
function attributes_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/attributes/{attributeDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `PUT /attributes/{attributeDbId}`
* @alias BrAPINode.prototype.attributes_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function attributes_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/attributes/{attributeDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /attributes_categories`
 * @alias BrAPINode.prototype.attributes_categories
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function attributes_categories (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/attributes/categories',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}


/** `POST /search/attributes -> GET /search/attributes`
* @alias BrAPINode.prototype.search_attributes
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_attributes(params,behavior){
    this.version.check("POST /search/attributes -> GET /search/attributes",{
        introduced:"v2.0"
    });
    return this.search("attributes",params,behavior);
}

/** `GET /attributevalues`
 * @alias BrAPINode.prototype.attributevalues
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function attributevalues (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/attributevalues',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /attributevalues`
* @alias BrAPINode.prototype.attributevalues_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function attributevalues_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/attributevalues',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /attributevalues/{attributeValueDbId}`
 * @alias BrAPINode.prototype.attributevalues_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.attributeValueDbId attributeValueDbId
 * @return {BrAPI_Behavior_Node}
 */
function attributevalues_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/attributevalues/{attributeValueDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /attributevalues/{attributeValueDbId}`
* @alias BrAPINode.prototype.attributevalues_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function attributevalues_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/attributevalues/{attributeValueDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `POST /search/attributevalues -> GET /search/attributevalues`
* @alias BrAPINode.prototype.search_attributevalues
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_attributevalues(params,behavior){
    this.version.check("POST /search/attributevalues -> GET /search/attributevalues",{
        introduced:"v2.0"
    });
    return this.search("attributevalues",params,behavior);
}

/** `GET /breedingmethods`
 * @alias BrAPINode.prototype.breedingmethods
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function breedingmethods (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/breedingmethods',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.2"
    });
    return this.simple_brapi_call(call);
}

/** `GET /breedingmethods/{breedingMethodDbId}`
 * @alias BrAPINode.prototype.breedingmethods_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.breedingMethodDbId breedingMethodDbId
 * @return {BrAPI_Behavior_Node}
 */
function breedingmethods_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/breedingmethods/{breedingMethodDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.2"
    });
    return this.simple_brapi_call(call);
}

/** `GET /calls`
 * @alias BrAPINode.prototype.calls
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function calls (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/calls',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /search/calls -> GET /search/calls`
* @alias BrAPINode.prototype.search_calls
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_calls(params,behavior){
    this.version.check("POST /search/calls -> GET /search/calls",{
        introduced:"v2.0"
    });
    return this.search("calls",params,behavior);
}

/** `GET /callsets`
 * @alias BrAPINode.prototype.callsets
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.germplasmDbId germplasmDbId
 * @return {BrAPI_Behavior_Node}
 */
function callsets (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/callsets',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `GET /callsets/{callSetDbId}`
 * @alias BrAPINode.prototype.callsets_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.callSetDbId callSetDbId
 * @return {BrAPI_Behavior_Node}
 */
function callsets_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/callsets/{callSetDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `GET /callsets/{callSetDbId}/calls`
 * @alias BrAPINode.prototype.callsets_calls
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.callSetDbId callSetDbId
 * @return {BrAPI_Behavior_Node}
 */
function callsets_calls (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/callsets/{callSetDbId}/calls',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `POST /search/callsets -> GET /search/callsets`
* @alias BrAPINode.prototype.search_callsets
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_callsets(params,behavior){
    this.version.check("POST /search/callsets -> GET /search/callsets",{
        introduced:"v2.0"
    });
    return this.search("callsets",params,behavior);
}

/** `GET /commoncropnames`(>=v1.2) or `GET /crops`(<v1.2)
 * @alias BrAPINode.prototype.commoncropnames
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function commoncropnames (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    if (this.version.predates("v1.3")){
        call.urlTemplate = "/crops";
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.3",
            deprecated:"v2.0"
        });
    } else {
        call.urlTemplate = "/commoncropnames";
        this.version.check(call.urlTemplate,{
            introduced:"v1.3"
        });
    }
    return this.simple_brapi_call(call);
}

/** `GET /crosses`
 * @alias BrAPINode.prototype.crosses
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function crosses (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/crosses',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /crosses`
* @alias BrAPINode.prototype.crosses_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function crosses_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/crosses',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /crosses`
* @alias BrAPINode.prototype.crosses_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function crosses_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/crosses',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /crossingprojects`
 * @alias BrAPINode.prototype.crossingprojects
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function crossingprojects (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/crossingprojects',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /crossingprojects`
* @alias BrAPINode.prototype.crossingprojects_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function crossingprojects_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/crossingprojects',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /crossingprojects/{crossingProjectDbId}`
 * @alias BrAPINode.prototype.crossingprojects_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.crossingProjectDbId crossingProjectDbId
 * @return {BrAPI_Behavior_Node}
 */
function crossingprojects_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/crossingprojects/{crossingProjectDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `PUT /crossingprojects/{crossingProjectDbId}`
* @alias BrAPINode.prototype.crossingprojects_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function crossingprojects_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/crossingprojects/{crossingProjectDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /events`
 * @alias BrAPINode.prototype.events
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function events (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/events',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /germplasm`
 * @alias BrAPINode.prototype.germplasm
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function germplasm (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/germplasm',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /germplasm`
* @alias BrAPINode.prototype.germplasm_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function germplasm_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/germplasm',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `POST /germplasm-search`
* @alias BrAPINode.prototype.germplasm_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function germplasm_search(params,behavior){
    return this.search_germplasm(params,behavior,true);
}

/** `GET /germplasm/{germplasmDbId}`
 * @alias BrAPINode.prototype.germplasm_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.germplasmDbId germplasmDbId
 * @return {BrAPI_Behavior_Node}
 */
function germplasm_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/germplasm/{germplasmDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /germplasm/{germplasmDbId}`
* @alias BrAPINode.prototype.germplasm_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function germplasm_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/germplasm/{germplasmDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /germplasm/{germplasmDbId}/mcpd`
 * @alias BrAPINode.prototype.germplasm_mcpd
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.germplasmDbId germplasmDbId
 * @return {BrAPI_Behavior_Node}
 */
function germplasm_mcpd (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/germplasm/{germplasmDbId}/mcpd',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `GET /germplasm/{germplasmDbId}/attributes`
 * @alias BrAPINode.prototype.germplasm_attributes
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.germplasmDbId germplasmDbId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function germplasm_attributes (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/germplasm/{germplasmDbId}/attributes',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /germplasm/{germplasmDbId}/pedigree`
 * @alias BrAPINode.prototype.germplasm_pedigree
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.germplasmDbId germplasmDbId
 * @return {BrAPI_Behavior_Node}
 */
function germplasm_pedigree (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/germplasm/{germplasmDbId}/pedigree',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /germplasm/{germplasmDbId}/progeny`
 * @alias BrAPINode.prototype.germplasm_progeny
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.germplasmDbId germplasmDbId
 * @param {String} [behavior="map"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function germplasm_progeny (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/germplasm/{germplasmDbId}/progeny',
        'params': params,
        'behaviorOptions': ['map','fork'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.2"
    });
    return this.simple_brapi_call(call);
}

/** `GET /germplasm/{germplasmDbId}/markerprofiles`
 * @alias BrAPINode.prototype.germplasm_markerprofiles
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.germplasmDbId germplasmDbId
 * @return {BrAPI_Behavior_Node}
 */
function germplasm_markerprofiles (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/germplasm/{germplasmDbId}/markerprofiles',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /germplasm-search`, `POST /search/germplasm -> GET /search/germplasm`
* @alias BrAPINode.prototype.search_germplasm
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_germplasm(params,behavior,useOld){
    if (this.version.predates("v1.3")||useOld){
        var call = {
            'defaultMethod': 'post',
            'urlTemplate': '/germplasm-search',
            'params': params,
            'behaviorOptions': ['fork','map'],
            'behavior': behavior,
        };
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.3",
            deprecated:"v2.0"
        });
        return this.simple_brapi_call(call);
    }
    else {
        this.version.check("POST /search/germplasm -> GET /search/germplasm",{
            introduced:"v1.3"
        });
        return this.search("germplasm",params,behavior);
    }
}

/** `GET /images`
 * @alias BrAPINode.prototype.images
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function images (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/images',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /images`
* @alias BrAPINode.prototype.images_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function images_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/images',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /images/{imageDbId}`
 * @alias BrAPINode.prototype.images_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.imageDbId imageDbId
 * @return {BrAPI_Behavior_Node}
 */
function images_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/images/{imageDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /images/{imageDbId}`
* @alias BrAPINode.prototype.images_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function images_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/images/{imageDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /images/{imageDbId}/imagecontent`
 * @alias BrAPINode.prototype.images_imagecontent
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.imageDbId imageDbId
 * @return {BrAPI_Behavior_Node}
 */
function images_imagecontent (params){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/images/{imageDbId}/imagecontent',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /images/{imageDbId}/imagecontent`
 * @alias BrAPINode.prototype.images_imagecontent_modify
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.imageDbId imageDbId
 * @return {BrAPI_Behavior_Node}
 */
function images_imagecontent_modify (params){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/images/{imageDbId}/imagecontent',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /search/images -> GET /search/images`
* @alias BrAPINode.prototype.search_images
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_images(params,behavior){
    this.version.check("POST /search/images -> GET /search/images",{
        introduced:"v1.3"
    });
    return this.search("images",params,behavior);
}

/** `GET /lists`
 * @alias BrAPINode.prototype.lists
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function lists (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/lists',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /lists`
* @alias BrAPINode.prototype.lists_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function lists_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/lists',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /lists/{listDbId}`
 * @alias BrAPINode.prototype.lists_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.listDbId listDbId
 * @return {BrAPI_Behavior_Node}
 */
function lists_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/lists/{listDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /lists/{listDbId}`
* @alias BrAPINode.prototype.lists_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function lists_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/lists/{listDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /lists/{listDbId}/items`
 * @alias BrAPINode.prototype.lists_items_store
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.imageDbId imageDbId
 * @return {BrAPI_Behavior_Node}
 */
function lists_items_store (params){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/lists/{listDbId}/items',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3",
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `POST /search/lists`
* @alias BrAPINode.prototype.lists_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function lists_search(params,behavior){
    return this.search_lists(params,behavior,true);
}

/** `POST /search/lists -> GET /search/lists`
* @alias BrAPINode.prototype.search_lists
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_lists(params,behavior){
    this.version.check("POST /search/lists -> GET /search/lists",{
        introduced:"v2.0"
    });
    return this.search("lists",params,behavior);
}

/** `GET /locations`
 * @alias BrAPINode.prototype.locations
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function locations (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/locations',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /locations`
* @alias BrAPINode.prototype.locations_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function locations_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/locations',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /locations/{locationDbId}`
 * @alias BrAPINode.prototype.locations_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.locationDbId locationDbId
 * @return {BrAPI_Behavior_Node}
 */
function locations_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/locations/{locationDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}


/** `PUT /locations/{locationDbId}`
* @alias BrAPINode.prototype.locations_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function locations_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/locations/{locationDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /search/locations`
* @alias BrAPINode.prototype.locations_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function locations_search(params,behavior){
    return this.search_locations(params,behavior,true);
}

/** `POST /search/locations -> GET /search/locations`
* @alias BrAPINode.prototype.search_locations
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_locations(params,behavior){
    this.version.check("POST /search/locations -> GET /search/locations",{
        introduced:"v2.0"
    });
    return this.search("locations",params,behavior);
}

/** `GET /maps`
 * @alias BrAPINode.prototype.maps
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function maps (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/maps',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /maps/{mapDbId}`
 * @alias BrAPINode.prototype.maps_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.mapDbId mapDbId
 * @param {String} [behavior=this.version.predates("v1.1")?"map":"fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function maps_detail (params, behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/maps/{mapDbId}',
        'params': params,
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    
    //added data array in v1.1, so default behavior changes
    if (this.version.predates("v1.1")){
        call.behaviorOptions = ['map'];
    } else {
        call.behaviorOptions = ['fork','map'];
    }
        
    return this.simple_brapi_call(call);
}

/** `GET /maps/{mapsDbId}/positions`
 * @alias BrAPINode.prototype.maps_positions
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.mapsDbId mapsDbId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function maps_positions (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/maps/{mapsDbId}/positions',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /maps/{mapsDbId}/positions/{linkageGroupId}`
 * @alias BrAPINode.prototype.maps_linkagegroups_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.mapsDbId mapsDbId
 * @param {String} params.linkageGroupId linkageGroupId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function maps_linkagegroups_detail (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/maps/{mapsDbId}/positions/{linkageGroupId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /maps/{mapsDbId}/linkagegroups`
 * @alias BrAPINode.prototype.maps_linkagegroups
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.mapsDbId mapsDbId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function maps_linkagegroups (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/maps/{mapsDbId}/linkagegroups',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /markerprofiles`
 * @alias BrAPINode.prototype.markerprofiles
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function markerprofiles (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/markerprofiles',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /markerprofiles-search`
* @alias BrAPINode.prototype.markerprofiles_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function markerprofiles_search(params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/markerprofiles-search',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v1.1"
    });
    return this.simple_brapi_call(call);
}

/** `GET /markerprofiles/{markerprofileDbId}`
 * @alias BrAPINode.prototype.markerprofiles_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.markerprofileDbId markerprofileDbId
 * @return {BrAPI_Behavior_Node}
 */
function markerprofiles_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/markerprofiles/{markerprofileDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /markers`
* @alias BrAPINode.prototype.markers
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function markers(params,behavior){
    var call = {
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    call.urlTemplate = "/markers";
    call.defaultMethod = "get";
    
    if(this.version.predates("v1.3")){
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.1",
            deprecated:"v2.0"
        });
    }
    else {
        this.version.check(call.urlTemplate,{
            introduced:"v1.3",
            deprecated:"v2.0"
        });
    }
    return this.simple_brapi_call(call);
}

/** `GET /markers/{markerDbId}`
 * @alias BrAPINode.prototype.markers_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.markerDbId markerDbId
 * @return {BrAPI_Behavior_Node}
 */
function markers_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/markers/{markerDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /markerpositions`
 * @alias BrAPINode.prototype.markerpositions
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function markerpositions (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/markerpositions',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /markers-search`
* @alias BrAPINode.prototype.markers_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function markers_search(params,behavior){
    return this.search_markers(params,behavior,true);
}

/** `POST /markers-search`, `POST /search/markers -> GET /search/markers`
* @alias BrAPINode.prototype.search_markers
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_markers(params,behavior,useOld){
    if (this.version.predates("v1.3")||useOld){
        var call = {
            'params': params,
            'behaviorOptions': ['fork','map'],
            'behavior': behavior,
        };
        call.urlTemplate = "/markers-search";
        call.defaultMethod = "post";
        this.version.check(call.urlTemplate,{
            introduced:"v1.1",
            deprecated:"v1.3",
            deprecated:"v2.0"
        });
        return this.simple_brapi_call(call);
    } else {
        this.version.check("POST /search/markers -> GET /search/markers",{
            introduced:"v1.3",
            deprecated:"v2.0"
        });
        return this.search("markers",params,behavior);
    }
}


/** `POST /search/markerpositions -> GET /search/markerpositions`
* @alias BrAPINode.prototype.search_markerpositions
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_markerpositions(params,behavior){
    this.version.check("POST /search/markerpositions -> GET /search/markerpositions",{
        introduced:"v2.0"
    });
    return this.search("markerpositions",params,behavior);
}

/** `GET /methods`
 * @alias BrAPINode.prototype.methods
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function methods (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/methods',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /methods`
* @alias BrAPINode.prototype.methods_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function methods_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/methods',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /methods/{methodDbId}`
 * @alias BrAPINode.prototype.methods_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.methodDbId methodDbId
 * @return {BrAPI_Behavior_Node}
 */
function methods_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/methods/{methodDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /methods/{methodDbId}`
* @alias BrAPINode.prototype.methods_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function methods_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/methods/{methodDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /observations`
 * @alias BrAPINode.prototype.observations
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function observations (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/observations',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /observations`
 * @alias BrAPINode.prototype.observations_store
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function observations_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/observations',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /observations`
 * @alias BrAPINode.prototype.observations_modify_multiple
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function observations_modify_multiple (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/observations',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `GET /observations/{observationDbId}`
 * @alias BrAPINode.prototype.observations_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.observationDbId observationDbId
 * @return {BrAPI_Behavior_Node}
 */
function observations_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/observations/{observationDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `PUT /observations/{observationDbId}`
* @alias BrAPINode.prototype.observations_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function observations_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/observations/{observationDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `GET /observations/table`
 * @alias BrAPINode.prototype.observations_table
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function observations_table (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate':'/observations/table',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    
    return this.simple_brapi_call(call);
}

/** `POST /search/observations -> GET /search/observations`
* @alias BrAPINode.prototype.search_observations
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_observations(params,behavior){
    this.version.check("POST /search/observations -> GET /search/observations",{
        introduced:"v2.0"
    });
    return this.search("observations",params,behavior);
}

/** `GET /observationlevels`(>=v1.2) or `GET /observationLevels`(<v1.2)
 * @alias BrAPINode.prototype.observationlevels
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function observationlevels (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    
    if (this.version.predates("v1.2")){
        call.urlTemplate = "/observationLevels";
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.2",
            deprecated:"v2.0"
        });
    } else {
        call.urlTemplate = "/observationlevels";
        this.version.check(call.urlTemplate,{
            introduced:"v1.2"
        });
    }
    
    return this.simple_brapi_call(call);
}

/** `GET /observationunits`
 * @alias BrAPINode.prototype.observationunits
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function observationunits (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/observationunits',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /observationunits`
* @alias BrAPINode.prototype.observationunits_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function observationunits_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/observationunits',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /observationunits`
* @alias BrAPINode.prototype.observationunits_modify_multiple
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function observationunits_modify_multiple (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/observationunits',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /observationunits/{observationUnitDbId}`
 * @alias BrAPINode.prototype.observationunits_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.observationUnitDbId observationUnitDbId
 * @return {BrAPI_Behavior_Node}
 */
function observationunits_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/observationunits/{observationUnitDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /observationunits/{observationUnitDbId}`
* @alias BrAPINode.prototype.observationunits_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function observationunits_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/observationunits/{observationUnitDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /observationunits/table`
 * @alias BrAPINode.prototype.observationunits_table
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function observationunits_table (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate':'/observationunits/table',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    
    return this.simple_brapi_call(call);
}


/** `POST /search/observationunits -> GET /search/observationunits`
* @alias BrAPINode.prototype.search_observationunits
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_observationunits(params,behavior){
    this.version.check("POST /search/observationunits -> GET /search/observationunits",{
        introduced:"v1.3"
    });
    return this.search("observationunits",params,behavior);
}

/** `POST /search/observationtables -> GET /search/observationtables`
* @alias BrAPINode.prototype.search_observationtables
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_observationtables(params,behavior){
    this.version.check("POST /search/observationtables -> GET /search/observationtables",{
        introduced:"v1.3",
        deprecated:"v2.0"
    });
    return this.search("observationtables",params,behavior);
}

/** `GET /ontologies`
 * @alias BrAPINode.prototype.ontologies
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function ontologies (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/ontologies',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /people`
 * @alias BrAPINode.prototype.people
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function people (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/people',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /people`
* @alias BrAPINode.prototype.people_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function people_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/people',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /people/{personDbId}`
 * @alias BrAPINode.prototype.people_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.personDbId personDbId
 * @return {BrAPI_Behavior_Node}
 */
function people_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/people/{personDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}


/** `PUT /people/{personDbId}`
* @alias BrAPINode.prototype.people_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function people_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/people/{personDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /search/people -> GET /search/people`
* @alias BrAPINode.prototype.search_people
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_people(params,behavior){
    this.version.check("POST /search/people -> GET /search/people",{
        introduced:"v2.0"
    });
    return this.search("people",params,behavior);
}

/** `POST /phenotypes`
 * @alias BrAPINode.prototype.phenotypes
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function phenotypes (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/phenotypes',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /phenotypes-search`
 * @alias BrAPINode.prototype.phenotypes_search
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function phenotypes_search (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/phenotypes-search',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /phenotypes-search/csv`
 * @alias BrAPINode.prototype.phenotypes_search_csv
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function phenotypes_search_csv (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/phenotypes-search/csv',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.2",
        deprecated:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /phenotypes-search/table`
 * @alias BrAPINode.prototype.phenotypes_search_table
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function phenotypes_search_table (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/phenotypes-search/table',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.2",
        deprecated:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /phenotypes-search/tsv`
 * @alias BrAPINode.prototype.phenotypes_search_tsv
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function phenotypes_search_tsv (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/phenotypes-search/tsv',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.2",
        deprecated:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `GET /plannedcrosses`
 * @alias BrAPINode.prototype.plannedcrosses
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function plannedcrosses (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/plannedcrosses',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /plannedcrosses`
* @alias BrAPINode.prototype.plannedcrosses_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function plannedcrosses_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/plannedcrosses',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `PUT /plannedcrosses`
* @alias BrAPINode.prototype.plannedcrosses_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function plannedcrosses_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/plannedcrosses',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /pedigree/{germplasmDbId}`
 * @alias BrAPINode.prototype.pedigree
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.germplasmDbId germplasmDbId
 * @return {BrAPI_Behavior_Node}
 */

function pedigree (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/pedigree/',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.1"
    });
    return this.simple_brapi_call(call);
}

/** `GET /programs`
 * @alias BrAPINode.prototype.programs
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function programs (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/programs',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /programs`
* @alias BrAPINode.prototype.programs_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function programs_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/programs',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /programs/{programDbId}`
 * @alias BrAPINode.prototype.programs_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.programDbId programDbId
 * @return {BrAPI_Behavior_Node}
 */
function programs_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/programs/{programDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /programs/{programDbId}`
* @alias BrAPINode.prototype.programs_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function programs_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/programs/{programDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /programs-search`
* @alias BrAPINode.prototype.programs_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function programs_search(params,behavior){
    return this.search_programs(params,behavior,true);
}

/** `POST /programs-search`, `POST /search/programs -> GET /search/programs`
* @alias BrAPINode.prototype.search_programs
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_programs(params,behavior,useOld){
    if (this.version.predates("v1.3")||useOld){
        var call = {
            'params': params,
            'behaviorOptions': ['fork','map'],
            'behavior': behavior,
        };
        call.urlTemplate = "/programs-search";
        call.defaultMethod = "post";
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.3",
            deprecated:"v2.0"
        });
        return this.simple_brapi_call(call);
    } else {
        this.version.check("POST /search/programs -> GET /search/programs",{
            introduced:"v1.3"
        });
        return this.search("programs",params,behavior);
    }
}

/** `GET /references`
 * @alias BrAPINode.prototype.references
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function references (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/references',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /references/{referenceDbId}`
 * @alias BrAPINode.prototype.references_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.referenceDbId referenceDbId
 * @return {BrAPI_Behavior_Node}
 */
function references_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/references/{referenceDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /references/{referenceDbId}/bases`
 * @alias BrAPINode.prototype.references_bases
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.referenceDbId referenceDbId
 * @return {BrAPI_Behavior_Node}
 */
function references_bases (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/references/{referenceDbId}/bases',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /search/references -> GET /search/references`
* @alias BrAPINode.prototype.search_references
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_references(params,behavior){
    this.version.check("POST /search/references -> GET /search/references",{
        introduced:"v2.0"
    });
    return this.search("references",params,behavior);
}

/** `GET /referencesets`
 * @alias BrAPINode.prototype.referencesets
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function referencesets (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/referencesets',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /referencesets/{referenceSetDbId}`
 * @alias BrAPINode.prototype.referencesets_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.referenceSetDbId referenceSetDbId
 * @return {BrAPI_Behavior_Node}
 */
function referencesets_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/referencesets/{referenceSetDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /search/referencesets -> GET /search/referencesets`
* @alias BrAPINode.prototype.search_referencesets
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_referencesets(params,behavior){
    this.version.check("POST /search/referencesets -> GET /search/referencesets",{
        introduced:"v2.0"
    });
    return this.search("referencesets",params,behavior);
}

/** `GET /samples`
 * @alias BrAPINode.prototype.samples
 * @param {Object} params Parameters to provide to the call
 * @return {BrAPI_Behavior_Node}
 */
function samples (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/samples',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /samples`
* @alias BrAPINode.prototype.samples_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function samples_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/samples',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /samples/{sampleDbId}`
 * @alias BrAPINode.prototype.samples_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.sampleDbId sampleDbId
 * @return {BrAPI_Behavior_Node}
 */
function samples_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/samples/{sampleDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /samples/{sampleDbId}`
 * @alias BrAPINode.prototype.samples_modify
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.sampleDbId sampleDbId
 * @return {BrAPI_Behavior_Node}
 */
function samples_modify (params){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/samples/{sampleDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /samples-search`
* @alias BrAPINode.prototype.samples_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function samples_search(params,behavior){
    return this.search_samples(params,behavior,true);
}

/** `POST /samples-search`, `POST /search/samples -> GET /search/samples`
* @alias BrAPINode.prototype.search_samples
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_samples(params,behavior,useOld){
    if (this.version.predates("v1.3")||useOld){
        var call = {
            'params': params,
            'behaviorOptions': ['fork','map'],
            'behavior': behavior,
        };
        call.urlTemplate = "/samples-search";
        call.defaultMethod = "post";
        this.version.check(call.urlTemplate,{
            introduced:"v1.1",
            deprecated:"v1.3",
            deprecated:"v2.0"
        });
        return this.simple_brapi_call(call);
    } else {
        this.version.check("POST /search/samples -> GET /search/samples",{
            introduced:"v1.3"
        });
        return this.search("samples",params,behavior);
    }
}

/** `GET /scales`
 * @alias BrAPINode.prototype.scales
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function scales (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/scales',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /scales`
* @alias BrAPINode.prototype.scales_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function scales_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/scales',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /scales/{scaleDbId}`
 * @alias BrAPINode.prototype.scales_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.scaleDbId scaleDbId
 * @return {BrAPI_Behavior_Node}
 */
function scales_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/scales/{scaleDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /scales/{scaleDbId}`
* @alias BrAPINode.prototype.scales_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function scales_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/scales/{scaleDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /search/{entity} then GET /search/{entity}/{searchResultsDbId}`
* @alias BrAPINode.prototype.search
* @param {String} entity Entity type to search over
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search(entity,params,behavior){
    var param_map = this.map(function(d){
        return typeof params === "function" ? params(d) : params;
    });
    var search_ids = param_map.search_POST(entity,function(p){
        var pageless_params = Object.assign({}, p);
        delete pageless_params.page;
        delete pageless_params.pageRange;
        //delete pageless_params.pageSize;
        return pageless_params;
    });
    return param_map.join(search_ids).search_GET(entity,function(joined){
        var get_params = {};console.log("joined",joined);
        // searchResultDbId for v1 compatibility
        get_params.searchResultsDbId = joined[1].searchResultsDbId || joined[1].searchResultDbId;
        if(joined[0].page!=undefined) get_params.page = joined[0].page;
        if(joined[0].pageRange!=undefined) get_params.pageRange = joined[0].pageRange;
        if(joined[0].pageSize!=undefined) get_params.pageSize = joined[0].pageSize;
        return get_params;
    })
    // return param_map.search_POST(entity,function(joined){
    //     var get_params = {};console.log("joined",joined);
    //     return get_params;
    // })
}

/** `POST /search/{entity}`
* @alias BrAPINode.prototype.search_POST
* @param {String} entity Entity type to search over
* @param {Object} params Parameters to provide to the call
* @return {BrAPI_Behavior_Node}
*/
function search_POST(entity,params){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/search/'+entity,
        'params': params,
        'behavior': 'map'
    };
    return this.simple_brapi_call(call);
}
/** `GET /search/{entity}/{searchResultsDbId}`
* @alias BrAPINode.prototype.search_GET
* @param {String} entity Entity type to search over
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_GET(entity,params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/search/'+entity+'/{searchResultsDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    return this.simple_brapi_call(call);
}

/** `GET /seasons`
 * @alias BrAPINode.prototype.seasons
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function seasons (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/seasons',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /seasons`
* @alias BrAPINode.prototype.seasons_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function seasons_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/seasons',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /seasons/{seasonDbId}`
 * @alias BrAPINode.prototype.seasons_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.seasonDbId seasonDbId
 * @return {BrAPI_Behavior_Node}
 */
function seasons_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/seasons/{seasonDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /seasons/{seasonDbId}`
* @alias BrAPINode.prototype.seasons_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function seasons_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/seasons/{seasonDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /seedlots`
 * @alias BrAPINode.prototype.seedlots
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function seedlots (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/seedlots',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /seedlots`
* @alias BrAPINode.prototype.seedlots_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function seedlots_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/seedlots',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /seedlots/{seedLotDbId}`
 * @alias BrAPINode.prototype.seedlots_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.seedLotDbId seedLotDbId
 * @return {BrAPI_Behavior_Node}
 */
function seedlots_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/seedlots/{seedLotDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /seedlots/{seedLotDbId}`
* @alias BrAPINode.prototype.seedlots_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function seedlots_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/seedlots/{seedLotDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /seedlots/transactions`
 * @alias BrAPINode.prototype.seedlots_transactions
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function seedlots_transactions (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/seedlots/transactions',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /seedlots/transactions`
* @alias BrAPINode.prototype.seedlots_transactions_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/

function seedlots_transactions_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/seedlots/transactions',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /seedlots/{seedLotDbId}/transactions`
 * @alias BrAPINode.prototype.seedlots_detail_transactions
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.seedLotDbId seedLotDbId
 * @return {BrAPI_Behavior_Node}
 */

function seedlots_detail_transactions (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/seedlots/{seedLotDbId}/transactions',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /serverinfo`
 * @alias BrAPINode.prototype.serverinfo
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function serverinfo (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/serverinfo',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /studies-search`
* @alias BrAPINode.prototype.studies_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function studies_search(params,behavior){
    return this.search_studies(params,behavior,true);
}

/** `POST /studies-search`, `POST /search/studies -> GET /search/studies`
* @alias BrAPINode.prototype.search_studies
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_studies(params,behavior,useOld){
    if (this.version.predates("v1.3")||useOld){
        var call = {
            'params': params,
            'behaviorOptions': ['fork','map'],
            'behavior': behavior,
        };
        call.urlTemplate = "/studies-search";
        call.defaultMethod = "post";
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.3",
            deprecated:"v2.0"
        });
        return this.simple_brapi_call(call);
    } else {
        this.version.check("POST /search/studies -> GET /search/studies",{
            introduced:"v1.3"
        });
        return this.search("studies",params,behavior);
    }
}

/** `GET /studies`
 * @alias BrAPINode.prototype.studies
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function studies (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/studies',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /studies`
 * @alias BrAPINode.prototype.studies_store
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function studies_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/studies',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}


/** `GET /studies/{studyDbId}`
 * @alias BrAPINode.prototype.studies_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @return {BrAPI_Behavior_Node}
 */
function studies_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/studies/{studyDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /studies/{studyDbId}`
 * @alias BrAPINode.prototype.studies_modify
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @return {BrAPI_Behavior_Node}
 */
function studies_modify (params){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/studies/{studyDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /studies/{studyDbId}/germplasm`
 * @alias BrAPINode.prototype.studies_germplasm
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function studies_germplasm (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/studies/{studyDbId}/germplasm',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /studies/{studyDbId}/layouts`, `GET /studies/{studyDbId}/layout`
 * @alias BrAPINode.prototype.studies_layouts
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function studies_layouts (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    if(this.version.predates("v1.3")){
        call.urlTemplate = '/studies/{studyDbId}/layout';
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v2.0"
        });
    } else {
        call.urlTemplate = '/studies/{studyDbId}/layouts';
        this.version.check(call.urlTemplate,{
            introduced:"v1.3",
            deprecated:"v2.0"
        });
    }
    return this.simple_brapi_call(call);
}

/** `GET /studies/{studyDbId}/observations`
 * @alias BrAPINode.prototype.studies_observations
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function studies_observations (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/studies/{studyDbId}/observations',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /studies/{studyDbId}/observations`(>=v1.1) or `POST /studies/{studyDbId}/observations`(<v1.1)
 * @alias BrAPINode.prototype.studies_observations_modify
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @return {BrAPI_Behavior_Node}
 */
function studies_observations_modify (params){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/studies/{studyDbId}/observations',
        'params': params,
        'behavior': 'map',
    };
    if(this.version.predates("v1.1")){
        call.defaultMethod = "post";
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.1",
            deprecated:"v2.0"
        });
    } else {
        call.defaultMethod = "put";
        this.version.check(call.urlTemplate,{
            introduced:"v1.1",
            deprecated:"v2.0"
        });
    }
    
    return this.simple_brapi_call(call);
}

/** `POST /studies/{studyDbId}/observations/zip`
 * @alias BrAPINode.prototype.studies_observations_zip
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @return {BrAPI_Behavior_Node}
 */
function studies_observations_zip (params){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/studies/{studyDbId}/observations/zip',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.1",
        deprecated:"v2.0"
    });
    
    return this.simple_brapi_call(call);
}

/** `GET /studies/{studyDbId}/observationvariables`
 * @alias BrAPINode.prototype.studies_observationvariables
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function studies_observationvariables (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    if(this.version.predates("v1.1")){
        call.urlTemplate= '/studies/{studyDbId}/observationVariables',
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.1",
            deprecated:"v2.0"
        });
    } else {
        call.urlTemplate= '/studies/{studyDbId}/observationvariables',
        this.version.check(call.urlTemplate,{
            introduced:"v1.1",
            deprecated:"v2.0"
        });
    }
    
    return this.simple_brapi_call(call);
}

/** `GET /studies/{studyDbId}/table`
 * @alias BrAPINode.prototype.studies_table
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function studies_table (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate':'/studies/{studyDbId}/table',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v2.0"
    });
    
    return this.simple_brapi_call(call);
}

/** `POST /studies/{studyDbId}/table`
 * @alias BrAPINode.prototype.studies_table_add
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.studyDbId studyDbId
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function studies_table_add (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate':'/studies/{studyDbId}/table',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v2.0"
    });
    
    return this.simple_brapi_call(call);
}

/** `GET /studytypes`(>=v1.1) or `GET /studyTypes`(<v1.1)
 * @alias BrAPINode.prototype.studytypes
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function studytypes (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    if(this.verison.predates("v1.1")){
        call.urlTemplate = '/studyTypes';
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.1",
            deprecated:"v2.0"
        });
    } else {
        call.urlTemplate = '/studytypes';
        this.version.check(call.urlTemplate,{
            introduced:"v1.1"
        });
    }
    
    return this.simple_brapi_call(call);
}

/** `GET /traits`
 * @alias BrAPINode.prototype.traits
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function traits (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/traits',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /traits`
* @alias BrAPINode.prototype.traits_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function traits_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/traits',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /traits/{traitDbId}`
 * @alias BrAPINode.prototype.traits_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.traitDbId traitDbId
 * @return {BrAPI_Behavior_Node}
 */
function traits_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/traits/{traitDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /traits/{traitDbId}`
* @alias BrAPINode.prototype.traits_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function traits_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/traits/{traitDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /trials`
 * @alias BrAPINode.prototype.trials
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function trials (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/trials',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /trials`
* @alias BrAPINode.prototype.trials_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function trials_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/trials',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /trials/{trialDbId}`
 * @alias BrAPINode.prototype.trials_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.trialDbId trialDbId
 * @return {BrAPI_Behavior_Node}
 */
function trials_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/trials/{trialDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}


/** `PUT /trials/{trialDbId}`
* @alias BrAPINode.prototype.trials_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function trials_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/trials/{trialDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /search/trials`
* @alias BrAPINode.prototype.trials_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function trials_search(params,behavior){
    return this.search_trials(params,behavior,true);
}

/** `POST /search/trials -> GET /search/trials`
* @alias BrAPINode.prototype.search_trials
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_trials(params,behavior){
    this.version.check("POST /search/trials -> GET /search/trials",{
        introduced:"v2.0"
    });
    return this.search("trials",params,behavior);
}

/** `GET /variables`
 * @alias BrAPINode.prototype.variables
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function variables (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variables',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /variables`
* @alias BrAPINode.prototype.variables_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function variables_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/variables',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /variables-search`
* @alias BrAPINode.prototype.variables_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function variables_search(params,behavior){
    return this.search_variables(params,behavior,true);
}

/** `POST /variables-search`, `POST /search/variables -> GET /search/variables`
* @alias BrAPINode.prototype.search_variables
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_variables(params,behavior,useOld){
    if (this.version.predates("v1.3")||useOld){
        var call = {
            'params': params,
            'behaviorOptions': ['fork','map'],
            'behavior': behavior,
        };
        call.urlTemplate = "/variables-search";
        call.defaultMethod = "post";
        this.version.check(call.urlTemplate,{
            introduced:"v1.0",
            deprecated:"v1.3"
        });
        return this.simple_brapi_call(call);
    } else {
        this.version.check("POST /search/variables -> GET /search/variables",{
            introduced:"v1.3"
        });
        return this.search("variables",params,behavior);
    }
}

/** `GET /variables/{observationVariableDbId}`
 * @alias BrAPINode.prototype.variables_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.observationVariableDbId observationVariableDbId
 * @return {BrAPI_Behavior_Node}
 */
function variables_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variables/{observationVariableDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0"
    });
    return this.simple_brapi_call(call);
}

/** `PUT /variables/{observationVariableDbId}`
* @alias BrAPINode.prototype.variables_modify
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function variables_modify (params,behavior){
    var call = {
        'defaultMethod': 'put',
        'urlTemplate': '/variables/{observationVariableDbId}',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /variables/datatypes`
 * @alias BrAPINode.prototype.variables_datatypes
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function variables_datatypes (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variables/datatypes',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.0",
        deprecated:"v1.3",
        deprecated:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /variants`
 * @alias BrAPINode.prototype.variants
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function variants (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variants',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /variants/{variantDbId}`
 * @alias BrAPINode.prototype.variants_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.variantDbId variantDbId
 * @return {BrAPI_Behavior_Node}
 */
function variants_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variants/{variantDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /variants/{variantDbId}/calls`
 * @alias BrAPINode.prototype.variants_calls
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.variantDbId variantDbId
 * @return {BrAPI_Behavior_Node}
 */
function variants_calls (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variants/{variantDbId}/calls',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /search/variants -> GET /search/variants`
* @alias BrAPINode.prototype.search_variants
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_variants(params,behavior){
    this.version.check("POST /search/variants -> GET /search/variants",{
        introduced:"v2.0"
    });
    return this.search("variants",params,behavior);
}

/** `GET /variantsets`
 * @alias BrAPINode.prototype.variantsets
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function variantsets (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variantsets',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /variantsets/extract`
* @alias BrAPINode.prototype.variantsets_extract_store
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function variantsets_extract_store (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/variantsets/extract',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /variantsets/{variantSetDbId}`
 * @alias BrAPINode.prototype.variantsets_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.variantSetDbId variantSetDbId
 * @return {BrAPI_Behavior_Node}
 */
function variantsets_detail (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variantsets/{variantSetDbId}',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /variantsets/{variantSetDbId}/calls`
* @alias BrAPINode.prototype.variantsets_calls
* @param {Object} params Parameters to provide to the call
* @param {String} params.variantSetDbId variantSetDbId
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function variantsets_calls (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variantsets/{variantSetDbId}/calls',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /variantsets/{variantSetDbId}/callsets`
* @alias BrAPINode.prototype.variantsets_callsets
* @param {Object} params Parameters to provide to the call
* @param {String} params.variantSetDbId variantSetDbId
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function variantsets_callsets (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variantsets/{variantSetDbId}/callsets',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /variantsets/{variantSetDbId}/variants`
* @alias BrAPINode.prototype.variantsets_variants
* @param {Object} params Parameters to provide to the call
* @param {String} params.variantSetDbId variantSetDbId
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function variantsets_variants (params,behavior){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/variantsets/{variantSetDbId}/variants',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `POST /search/variantsets -> GET /search/variantsets`
* @alias BrAPINode.prototype.search_variantsets
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function search_variantsets(params,behavior){
    this.version.check("POST /search/variantsets -> GET /search/variantsets",{
        introduced:"v2.0"
    });
    return this.search("variantsets",params,behavior);
}

/** `POST /vendor/plates`
 * @alias BrAPINode.prototype.vendor_plates
 * @param {Object} params Parameters to provide to the call
 * @param {String} [behavior="fork"] Behavior of the node
 * @return {BrAPI_Behavior_Node}
 */
function vendor_plates (params,behavior){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/vendor/plates',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.1"
    });
    return this.simple_brapi_call(call);
}

/** `POST /vendor/plates-search`(>=v1.2) or `POST /vendor/plate-search`(<v1.2)
* @alias BrAPINode.prototype.vendor_plates_search
* @param {Object} params Parameters to provide to the call
* @param {String} [behavior="fork"] Behavior of the node
* @return {BrAPI_Behavior_Node}
*/
function vendor_plates_search(params,behavior){
    var call = {
        'defaultMethod': 'post',
        'params': params,
        'behaviorOptions': ['fork','map'],
        'behavior': behavior,
    };
    if(this.version.predates("v1.2")){
        call.urlTemplate = '/vendor/plate-search';
        this.version.check(call.urlTemplate,{
            introduced:"v1.1",
            deprecated:"v1.2",
            deprecated:"v2.0"
        });
    } else {
        call.urlTemplate = '/vendor/plates-search';
        this.version.check(call.urlTemplate,{
            introduced:"v1.2",
            deprecated:"v1.3",
            deprecated:"v2.0"
        });
    }
    return this.simple_brapi_call(call);
}

/** `GET /vendor/plates/{submissionId}`
 * @alias BrAPINode.prototype.vendor_plates_detail
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.submissionId submissionId
 * @return {BrAPI_Behavior_Node}
 */
function vendor_plates_detail (params){
    var call = {
        'defaultMethod': 'get',
        'params': params,
        'behavior': 'map',
    };
    if(this.version.predates("v1.2")){
        call.urlTemplate = '/vendor/plate/{submissionId}';
        this.version.check(call.urlTemplate,{
            introduced:"v1.1",
            deprecated:"v1.2"
        });
    } else {
        call.urlTemplate = '/vendor/plates/{submissionId}';
        this.version.check(call.urlTemplate,{
            introduced:"v1.2"
        });
    }
    return this.simple_brapi_call(call);
}

/** `GET /vendor/specifications`
 * @alias BrAPINode.prototype.vendor_specifications
 * @param {Object} params Parameters to provide to the call
 * @return {BrAPI_Behavior_Node}
 */
function vendor_specifications (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/vendor/specifications',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.1"
    });
    return this.simple_brapi_call(call);
}

/** `GET /vendor/orders`
 * @alias BrAPINode.prototype.vendor_orders
 * @param {Object} params Parameters to provide to the call
 * @return {BrAPI_Behavior_Node}
 */
function vendor_orders (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/vendor/orders',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `POST /vendor/orders`
 * @alias BrAPINode.prototype.vendor_orders_store
 * @param {Object} params Parameters to provide to the call
 * @return {BrAPI_Behavior_Node}
 */
function vendor_orders_store (params){
    var call = {
        'defaultMethod': 'post',
        'urlTemplate': '/vendor/orders',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v2.0"
    });
    return this.simple_brapi_call(call);
}

/** `GET /vendor/orders/{orderId}/results`
 * @alias BrAPINode.prototype.vendor_orders_results
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.orderId orderId
 * @return {BrAPI_Behavior_Node}
 */
function vendor_orders_results (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/vendor/orders/{orderId}/results',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `GET /vendor/orders/{orderId}/plates`
 * @alias BrAPINode.prototype.vendor_orders_plates
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.orderId orderId
 * @return {BrAPI_Behavior_Node}
 */
function vendor_orders_plates (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/vendor/orders/{orderId}/plates',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}

/** `GET /vendor/orders/{orderId}/status`
 * @alias BrAPINode.prototype.vendor_orders_status
 * @param {Object} params Parameters to provide to the call
 * @param {String} params.orderId orderId
 * @return {BrAPI_Behavior_Node}
 */
function vendor_orders_status (params){
    var call = {
        'defaultMethod': 'get',
        'urlTemplate': '/vendor/orders/{orderId}/status',
        'params': params,
        'behavior': 'map',
    };
    this.version.check(call.urlTemplate,{
        introduced:"v1.3"
    });
    return this.simple_brapi_call(call);
}



var brapiMethods = Object.freeze({
	allelematrices: allelematrices,
	allelematrices_search: allelematrices_search,
	attributes: attributes,
	attributes_store: attributes_store,
	attributes_detail: attributes_detail,
	attributes_modify: attributes_modify,
	attributes_categories: attributes_categories,
	search_attributes: search_attributes,
	attributevalues: attributevalues,
	attributevalues_store: attributevalues_store,
	attributevalues_detail: attributevalues_detail,
	attributevalues_modify: attributevalues_modify,
	search_attributevalues: search_attributevalues,
	breedingmethods: breedingmethods,
	breedingmethods_detail: breedingmethods_detail,
	calls: calls,
	search_calls: search_calls,
	callsets: callsets,
	callsets_detail: callsets_detail,
	callsets_calls: callsets_calls,
	search_callsets: search_callsets,
	commoncropnames: commoncropnames,
	crosses: crosses,
	crosses_store: crosses_store,
	crosses_modify: crosses_modify,
	crossingprojects: crossingprojects,
	crossingprojects_store: crossingprojects_store,
	crossingprojects_detail: crossingprojects_detail,
	crossingprojects_modify: crossingprojects_modify,
	events: events,
	germplasm: germplasm,
	germplasm_store: germplasm_store,
	germplasm_search: germplasm_search,
	germplasm_detail: germplasm_detail,
	germplasm_modify: germplasm_modify,
	germplasm_mcpd: germplasm_mcpd,
	germplasm_attributes: germplasm_attributes,
	germplasm_pedigree: germplasm_pedigree,
	germplasm_progeny: germplasm_progeny,
	germplasm_markerprofiles: germplasm_markerprofiles,
	search_germplasm: search_germplasm,
	images: images,
	images_store: images_store,
	images_detail: images_detail,
	images_modify: images_modify,
	images_imagecontent: images_imagecontent,
	images_imagecontent_modify: images_imagecontent_modify,
	search_images: search_images,
	lists: lists,
	lists_store: lists_store,
	lists_detail: lists_detail,
	lists_modify: lists_modify,
	lists_items_store: lists_items_store,
	lists_search: lists_search,
	search_lists: search_lists,
	locations: locations,
	locations_store: locations_store,
	locations_detail: locations_detail,
	locations_modify: locations_modify,
	locations_search: locations_search,
	search_locations: search_locations,
	maps: maps,
	maps_detail: maps_detail,
	maps_positions: maps_positions,
	maps_linkagegroups_detail: maps_linkagegroups_detail,
	maps_linkagegroups: maps_linkagegroups,
	markerprofiles: markerprofiles,
	markerprofiles_search: markerprofiles_search,
	markerprofiles_detail: markerprofiles_detail,
	markers: markers,
	markers_detail: markers_detail,
	markerpositions: markerpositions,
	markers_search: markers_search,
	search_markers: search_markers,
	search_markerpositions: search_markerpositions,
	methods: methods,
	methods_store: methods_store,
	methods_detail: methods_detail,
	methods_modify: methods_modify,
	observations: observations,
	observations_store: observations_store,
	observations_modify_multiple: observations_modify_multiple,
	observations_detail: observations_detail,
	observations_modify: observations_modify,
	observations_table: observations_table,
	search_observations: search_observations,
	observationlevels: observationlevels,
	observationunits: observationunits,
	observationunits_store: observationunits_store,
	observationunits_modify_multiple: observationunits_modify_multiple,
	observationunits_detail: observationunits_detail,
	observationunits_modify: observationunits_modify,
	observationunits_table: observationunits_table,
	search_observationunits: search_observationunits,
	search_observationtables: search_observationtables,
	ontologies: ontologies,
	people: people,
	people_store: people_store,
	people_detail: people_detail,
	people_modify: people_modify,
	search_people: search_people,
	phenotypes: phenotypes,
	phenotypes_search: phenotypes_search,
	phenotypes_search_csv: phenotypes_search_csv,
	phenotypes_search_table: phenotypes_search_table,
	phenotypes_search_tsv: phenotypes_search_tsv,
	plannedcrosses: plannedcrosses,
	plannedcrosses_store: plannedcrosses_store,
	plannedcrosses_modify: plannedcrosses_modify,
	pedigree: pedigree,
	programs: programs,
	programs_store: programs_store,
	programs_detail: programs_detail,
	programs_modify: programs_modify,
	programs_search: programs_search,
	search_programs: search_programs,
	references: references,
	references_detail: references_detail,
	references_bases: references_bases,
	search_references: search_references,
	referencesets: referencesets,
	referencesets_detail: referencesets_detail,
	search_referencesets: search_referencesets,
	samples: samples,
	samples_store: samples_store,
	samples_detail: samples_detail,
	samples_modify: samples_modify,
	samples_search: samples_search,
	search_samples: search_samples,
	scales: scales,
	scales_store: scales_store,
	scales_detail: scales_detail,
	scales_modify: scales_modify,
	search: search,
	search_POST: search_POST,
	search_GET: search_GET,
	seasons: seasons,
	seasons_store: seasons_store,
	seasons_detail: seasons_detail,
	seasons_modify: seasons_modify,
	seedlots: seedlots,
	seedlots_store: seedlots_store,
	seedlots_detail: seedlots_detail,
	seedlots_modify: seedlots_modify,
	seedlots_transactions: seedlots_transactions,
	seedlots_transactions_store: seedlots_transactions_store,
	seedlots_detail_transactions: seedlots_detail_transactions,
	serverinfo: serverinfo,
	studies_search: studies_search,
	search_studies: search_studies,
	studies: studies,
	studies_store: studies_store,
	studies_detail: studies_detail,
	studies_modify: studies_modify,
	studies_germplasm: studies_germplasm,
	studies_layouts: studies_layouts,
	studies_observations: studies_observations,
	studies_observations_modify: studies_observations_modify,
	studies_observations_zip: studies_observations_zip,
	studies_observationvariables: studies_observationvariables,
	studies_table: studies_table,
	studies_table_add: studies_table_add,
	studytypes: studytypes,
	traits: traits,
	traits_store: traits_store,
	traits_detail: traits_detail,
	traits_modify: traits_modify,
	trials: trials,
	trials_store: trials_store,
	trials_detail: trials_detail,
	trials_modify: trials_modify,
	trials_search: trials_search,
	search_trials: search_trials,
	variables: variables,
	variables_store: variables_store,
	variables_search: variables_search,
	search_variables: search_variables,
	variables_detail: variables_detail,
	variables_modify: variables_modify,
	variables_datatypes: variables_datatypes,
	variants: variants,
	variants_detail: variants_detail,
	variants_calls: variants_calls,
	search_variants: search_variants,
	variantsets: variantsets,
	variantsets_extract_store: variantsets_extract_store,
	variantsets_detail: variantsets_detail,
	variantsets_calls: variantsets_calls,
	variantsets_callsets: variantsets_callsets,
	variantsets_variants: variantsets_variants,
	search_variantsets: search_variantsets,
	vendor_plates: vendor_plates,
	vendor_plates_search: vendor_plates_search,
	vendor_plates_detail: vendor_plates_detail,
	vendor_specifications: vendor_specifications,
	vendor_orders: vendor_orders,
	vendor_orders_store: vendor_orders_store,
	vendor_orders_results: vendor_orders_results,
	vendor_orders_plates: vendor_orders_plates,
	vendor_orders_status: vendor_orders_status
});

class BrAPI_Version_Class {
    constructor(version) {
        var varr  = (""+version).trim().replace(/^(v|V)/,"").split(".");
        if (varr.length<1) throw Error("not a version");
        this.major = varr[0];
        this.minor = varr.length>1 ? varr[1] : null;
        this.patch = varr.length>2 ? varr[2] : null;
    }
    within(other){
        if (typeof other == "string") other = brapiVersion(other);
        
        if (this.major!=other.major) {
            return false;
        }
        else if (this.minor!=other.minor && other.minor) {
            return false;
        }
        else if (this.patch!=other.patch && other.patch) {
            return false;
        }
        
        return true;
    }
    predates(other){
        if (typeof other == "string") other = brapiVersion(other);
        
        if (this.major < other.major) {
            return true;
        }
        else if (this.major > other.major) {
            return false;
        }
        else if (this.minor < other.minor) {
            return true;
        }
        else if (this.minor > other.minor) {
            return false;
        }
        else if (this.patch < other.patch) {
            return true;
        }
        else if (this.patch > other.patch) {
            return false;
        }
        
        return false;
    }
    string(){
        var s = "v"+this.major;
        if (this.minor) {
            s+="."+this.minor;
            if (this.patch) {
                s+="."+this.patch;
            }
        }
        return s;
    }
    /**
     * Checks that the version of a BrAPI call matches the connected server version.
     * @private 
     * @param  {String} name   Name of BrAPI call
     * @param  {Object} check Versions to check
     * @param  {String} check.introduced When the call was introduced
     * @param  {String} check.deprecated When the call was deprecated
     * @param  {String} check.removed    When the call was removed
     */
    check(name,check){
        if (check.introduced) check.introduced = brapiVersion(check.introduced);
        if (check.deprecated) check.deprecated = brapiVersion(check.deprecated);
        if (check.removed) check.removed = brapiVersion(check.removed);
        
        if (check.introduced && this.predates(check.introduced)){
            console.warn(name+" is unintroduced in BrAPI@"+this.string()+" before BrAPI@"+check.introduced.string());
        }
        else if (check.deprecated && !this.predates(check.deprecated)){
            console.warn(name+" is deprecated in BrAPI@"+this.string()+" since BrAPI@"+check.deprecated.string());
        }
        else if (check.removed && check.removed.predates(this)){
            console.warn(name+" was removed from BrAPI@"+this.string()+" since BrAPI@"+check.removed.string());
        }
    }
}

function brapiVersion(version_string){
    return new BrAPI_Version_Class(version_string);
}

try {
    var fetch = window.fetch;
} catch(e){
    var fetch = require('node-fetch');
}

class BrAPINode extends ThreadNode {
    constructor(brapi_controller) {
        super(Array.prototype.slice.call(arguments,1));
        this.brapi = brapi_controller;
        this.version = this.brapi.version;
        this.pollFunc = function(){return 15000};
    }
    _outputNode(){
        return new BrAPINode(this.brapi);
    }
    poll(callback){
        var last = this.pollFunc;
        this.pollFunc = function(response){
            var last_result = last(response);
            return callback(response) || last_result;
        };
        return this;
    }
    server(address,version,auth_token,call_limit){
        var newNode = this.map(d=>d);
        newNode.brapi = new BrAPICallController(address,version,auth_token,call_limit||5);
        newNode.version = newNode.brapi.version;
        return newNode;
    }
    simple_brapi_call(call){
        // {
        //     'defaultMethod': 'get',
        //     'urlTemplate': '/breedingmethods',
        //     'params': params,
        //     'behaviorOptions': ['fork','map'],
        //     'behavior': behavior,
        // }
        
        // check if behavior is specified and in behaviorOptions if 
        // behaviorOptions exists, otherwise use behaviorOptions[0] if 
        // behaviorOptions exists, otherwise deafult to "map"
        var behavior = call.behaviorOptions ? 
            (call.behaviorOptions.indexOf(call.behavior) >= 0 ? 
                call.behavior : 
                call.behaviorOptions[0]) :
              (call.behavior || "map");
    
        // check if the parameters are specified as a function or an object
        var multicall = typeof call.params === "function";
        if(!multicall) {
            var _callparams = call.params;
            call.params = function(){return _callparams};
        }
        
        var self = this;
        
        var fray = function(){
            var target = multicall?self:(new EmptyBrAPINode(self.brapi));
            return self._fray.apply(target,arguments);
        };
        
        var frayed = fray(function(datum, send){
            var datum_raw_params = Object.assign({}, call.params(datum.val));
            var datum_call = self.consumeUrlParams(
                call.urlTemplate,
                datum_raw_params
            );
            var method = datum_call.params.HTTPMethod?
                datum_call.params.HTTPMethod:
                call.defaultMethod;
            if(datum_call.params.HTTPMethod) delete datum_call.params.HTTPMethod;
            
            var pageRange = datum_call.params.pageRange?
                datum_call.params.pageRange:
                null;
            if(datum_call.params.pageRange) delete datum_call.params.pageRange;
            
            var loaded = [];
            
            var loadPage = function(page){
                return self.brapi.call(
                    method,
                    datum_call.url,
                    datum_call.params,
                    page,
                    self.pollFunc
                )
            };
            
            var loadFurther;
            
            if(behavior=="map"){
                loadFurther = function(initialResult){
                    if(!initialResult.isPaginated){
                        return [new DatumWrapper(
                            initialResult.result, 
                            datum.key
                        )];
                    }
                    else {
                        if(!pageRange){
                            pageRange = initialResult.furtherPageRange;
                        }
                        var further_pages = [];
                        // for (var i = pageRange[0]+1; i < pageRange[1]; i++) {
                        //     further_pages.push(
                        //         loadPage(i)
                        //     );
                        // }
                        return Promise.all(further_pages).then(function(furtherResults){
                            initialResult.metadata.currentPage = [initialResult.metadata.currentPage];
                            furtherResults.forEach(function(furtherResponse){
                                Array.prototype.push.apply(
                                    initialResult.result.data,
                                    furtherResponse.result.data
                                );
                                initialResult.metadata.currentPage.push(
                                    furtherResponse.metadata.currentPage
                                );
                            });
                            initialResult.metadata.currentPage.sort();
                            return [new DatumWrapper(
                                initialResult.result, 
                                datum.key
                            )];
                        })
                    }
                };
            }
            else if(behavior=="fork"){
                var fray_index = 0;
                var fray_key = function(){return datum.key+","+(fray_index++)};
                var frayResult = function(result){
                    return result.data.map(function(d){
                        d.__response = result.__response;
                        return (new DatumWrapper(d,fray_key()));
                    })
                };
                loadFurther = function(initialResult){
                    if(!initialResult.isPaginated){
                        return [new DatumWrapper(
                            initialResult.result, 
                            fray_key()
                        )];
                    }
                    else {
                        if(!pageRange){
                            pageRange = initialResult.furtherPageRange;
                        }
                        var further_pages = [];
                        // for (var i = pageRange[0]+1; i < pageRange[1]; i++) {
                        //     further_pages.push(
                        //         loadPage(i)
                        //     );
                        // }
                        return [frayResult(initialResult.result)].concat(further_pages.map(function(pg){
                            return pg.then(function(furtherResult){return frayResult(furtherResult.result)})
                        }));
                    }
                };
            }
            
            send(loadPage(pageRange?pageRange[0]:undefined).then(loadFurther));
            
        });
        return frayed;

        // // create a brapi call
        // return this.brapi_call(behavior,call.defaultMethod,function(datum){
        //   // create or duplicate the parameters for this datum (create shallow copy to protect original parmeter object)
        //   var datum_params = Object.assign({}, multicall ? call.params(datum) : call.params);
        //   // fill urlTemplate with specified parameters and remove them from the datum_params
        //   return this.consumeUrlParams(call.urlTemplate,datum_params);
        // }, multicall)
    }
    
    /**
     * Constructs a url from a url_template and clears the used params from the
     * parameter object.
     * @param  {String} url_template template of form "/urlpath/{param_name}/blah/{other_param_name}"
     * @param  {Object} params       Object containing properties matching the url params
     * @return {Object}              Object with url and params properties
     */
    consumeUrlParams(url_template,params){
        return {
            'url': url_template.replace(/\{([a-z_$]+?)\}/gi, function(match,param_name){
                var val = encodeURIComponent(params[param_name]);
                delete params[param_name];
                return val;
            }),
            'params': params
        }
    }
}

class EmptyBrAPINode extends BrAPINode{
    constructor(brapi_controller) {
        super(...arguments);
        var ownInput = this._connect(null);
        ownInput.send([this._wrap_datum(null)]);
        ownInput.finish();
    }
}
EmptyBrAPINode.prototype.data = EmptyThreadNode.prototype.data;

class BrAPICallController {
    constructor(brapi_base_url,version,brapi_auth_token,max_calls,credentials){
        this.max_calls = max_calls || 5;
        this.call_queue = [];
        this.version = brapiVersion(version||1.2);
        this.running = 0;
        this.brapi_base_url = brapi_base_url;
        this.brapi_auth_token = brapi_auth_token;
        this.credentials = credentials || 'same-origin';
    }
    call(){
        var self = this;
        var callArgs = arguments;
        var queue_item = {};
        var result_promise = new Promise(function(resolve,reject){
            queue_item.run = function(){
                self._call.apply(self, callArgs).then(resolve);
            };
        });
        this.call_queue.push(queue_item);
        this._run_from_queue();
        return result_promise;
    }
    _run_from_queue(){
        while(this.call_queue.length>0 && this.running<this.max_calls){
            var call = this.call_queue.shift();
            call.run();
            this.running += 1;
        }
    }
    _call(method, url, params, page, pollFunc){
        if(page) params.page = page;
        var body = undefined;
        url = this.brapi_base_url+url;
        if (method=="patch" || method=="put" || method=="post"){
            body = JSON.stringify(params);
        }
        else{
            url = url+BrAPICallController.formatURLParams(params);
        }
        var fetch_opts = {
            method: method,
            cache: "no-cache",
            credentials: this.credentials,
            headers: {
                'Content-Type': 'application/json;charset=utf-8'
            },
            body: body
        };
        if (this.brapi_auth_token) {
            if (!this.brapi_base_url.startsWith("https")) {
                console.warn("You should send the BrAPI.js authentication token over https!");
            }
            console.log("auth", this.brapi_auth_token);
            fetch_opts.headers.Authorization = "Bearer " + this.brapi_auth_token;
        }
        // console.log("fetch(",url,",",fetch_opts,")")
        var self = this;
        var status;
        return fetch(url,fetch_opts)
            .then(function(resp){
                self.running -= 1;
                self._run_from_queue();
                return resp
            })
            .then(function(response) { 
                status = response.status;
                return response.json(); 
            })
            .then(function(response) {
                return self.checkAsync(url,fetch_opts,pollFunc,response,undefined); 
            })
            .then(BrAPICallController.parseBrAPIResponse);
    }
    
    static parseBrAPIResponse(resp){
        var brapiInfo = {
            result: resp.result || resp, //(status == '202') ? resp :{},
            metadata:resp.metadata
        };
        // console.log(resp);
        if(resp.metadata.pagination && resp.metadata.pagination.pageSize){
            brapiInfo.isPaginated = true;
            brapiInfo.furtherPageRange = [
                resp.metadata.pagination.currentPage,
                resp.metadata.pagination.totalPages
            ];
        } else {
            brapiInfo.isPaginated = false;
        }
        
        brapiInfo.result.__response = resp;
        return brapiInfo;
    }
    
    checkAsync(url,fetch_opts,pollFunc,response,isPolling){
        var self = this;
        //<v1.2 asynch initiate
        if(!isPolling && response.metadata.status && Array.isArray(response.metadata.status)){
            for (var i = 0; i < response.metadata.status.length; i++) {
                if(response.metadata.status[i].code=="asynchid"){
                    url = url.split(/\?(.+)/)[0];
                    url += "/status/"+response.metadata.status[i].message;
                    fetch_opts.method = "get";
                    delete fetch_opts.body;
                    isPolling = true;
                }
            }
        }
        //>=v1.2 asynch initiate
        if(!isPolling && response.metadata.asynchStatus && response.metadata.asynchStatus.asynchId && response.metadata.asynchStatus.status != "FINISHED"){
            url = url.split(/\?(.+)/)[0];
            url += "/"+response.metadata.asynchStatus.asynchId;
            fetch_opts.method = "get";
            delete fetch_opts.body;
            isPolling = true;
        }
        if(isPolling){
            var pollAgain = false;
            //>=v1.2 asynch poll
            if(response.metadata.asynchStatus && response.metadata.asynchStatus.status != "FINISHED"){
                pollAgain = true;
            }
            //<v1.2 asynch poll
            if(response.metadata.status && Array.isArray(response.metadata.status)){
                for (var i = 0; i < response.metadata.status.length; i++) {
                    if(response.metadata.status[i].code=="asynchid" || response.metadata.status[i].code=="asynchstatus" && response.metadata.status[i].message!="FINISHED"){
                        pollAgain = true;
                    }
                }
            }
            //If we are still polling, queue the next poll
            if(pollAgain){
                var self = this;
                return new Promise(function(resolve,reject){
                    setTimeout(function(){
                        var queue_item = {run:function(){
                            resolve(fetch(url,fetch_opts)
                                .then(function(resp){
                                    self.running -= 1;
                                    self._run_from_queue();
                                    return resp
                                })
                                .then(function(response){return response.json();})
                                .then(function(response) { 
                                    return self.checkAsync(url,fetch_opts,pollFunc,response,true); 
                                }));
                        }};
                        self.call_queue.push(queue_item);
                        self._run_from_queue();
                    },pollFunc(response));
                })
            }
        }
        return response
    }
    
    static formatURLParams(params){
        var start = true;
        var param_string = "";
        for (var param in params) {
            if (start) {
                param_string+="?";
                start = false;
            } else {
                param_string+="&";
            }
            param_string+=param+"=";
            if (params[param] instanceof Array){
                param_string+=params[param].map(String).join("%2C");
            }
            else {
                param_string+=String(params[param]);
            }
        }
        return param_string
    }
}

// Apply each brapi method to BrAPINode
Object.keys(brapiMethods).forEach(function(method_name){
    BrAPINode.prototype[method_name] = brapiMethods[method_name];
    EmptyBrAPINode.prototype[method_name] = brapiMethods[method_name];
});

/**
 * BrAPI - initializes a BrAPI client handler
 *  
 * @param   {String} server      URL without trailing '/' to the BrAPI endpoint 
 * @param   {String} version     Optional. BrAPI version of endpoint (e.g. "1.2" or "v1.1") 
 * @param   {String} auth_token  Optional. BrAPI Auth Bearer token.
 * @param   {Int}    call_limit  Optional. Maximum number of simultanious calls the server which can be running.
 * @param   {String} credentials Optional. credentials option to use for fetch API.  See: https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials
 * @returns {EmptyBrAPINode}            
 */ 
function BrAPI(address, version, auth_token, call_limit, credentials){
    return new EmptyBrAPINode(
        new BrAPICallController(address,version,auth_token,call_limit||5, credentials)
    );
}

// BrAPI("https://cassavabase.org/brapi/v1",null,null,5)
// .data(["00122","00135"]).germplasm_search(function(d){
//     return {'germplasmNames':d}
// }).each(function(d,key){console.log(key,d.germplasmName)}).germplasm_pedigree(d=>{
//     return {germplasmDbId:d.germplasmDbId}
// })
// .each(function(d,key){console.log(key,d.parent1DbId)})
// .filter(function(d){return d.parent1DbId})
// .each(function(d,key){console.log(key, "Not Null", d.parent1DbId)})
// .germplasm_detail(function(d){return {germplasmDbId:d.parent1DbId}})
// .each(function(d,key){console.log(key,d.germplasmName)})
// .all(da=>console.log(da.map(d=>d.germplasmName)))

var main = BrAPI;

return main;

})));
