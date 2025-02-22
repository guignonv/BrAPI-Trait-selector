(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
  typeof define === 'function' && define.amd ? define(factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.BrAPITraitSelector = factory());
})(this, (function () { 'use strict';

  /**
   * [BrAPITraitSelector description]
   */


  class BrAPITraitSelector {

      constructor( brapi_endpoint, svg_container, svg_file, traits_div,filtered_table, svg_config, opts) {

          //declare variables
          this.brapi_endpoint = brapi_endpoint;
          this.svg_container =  svg_container;
          this.svg_config =  svg_config;
          var currentGFilter = null;


          var svgContainer = document.getElementById(svg_container);
          var traitListContainer = document.querySelector("#" + traits_div);
          var svgContent;

          // Load SVG.
          const xhr = new XMLHttpRequest();
          xhr.onload = () => {
              svgContent = xhr.responseXML.documentElement;
              svgContainer.appendChild(svgContent);
              svgContent.querySelectorAll(".brapi-zoomable").forEach(function(x) {
                  x.style.display = "none";
                  x.style.opacity = 0;
              });            

              svgContent.querySelectorAll(".brapi-entity").forEach(function(x) {


                  var entity = x.getAttribute("name");
                  var zoomable = svgContent.querySelectorAll('.brapi-zoomable[name="' + x.getAttribute("name") + '"]');
                  var entity_searchable = [entity];

                  if(svg_config[entity]){
                      entity_searchable = svg_config[entity].entities;
                  } 

                  //creates div for entity popups
                  var tip = document.createElement("div");
                  tip.id = 'tsTip_'+ entity;
                  tip.classList.add("tsTip");
                  document.body.appendChild(tip);
                  tip.style.display = "none";

                  x.addEventListener('mouseover', (e) => {
                      e.target.style.cursor="pointer";
                      
                      if(zoomable.length >0){
                          zoomable[0].style.display = "inline";
                          window.setTimeout(function(){
                              zoomable[0].style.opacity = 1;
                            },100);
                      }                   

                      //adding svg popups with name
                      document.getElementById("tsTip_" + entity).innerHTML =  entity;
                      tip.style.top = e.pageY - 30 + 'px';
                      tip.style.left = e.pageX  + 10 + 'px';
                      tip.style.display = "inline";

                  });
                  x.addEventListener('mouseleave', (e) => {
                      tip.style.display = "none";
                  });
                  x.addEventListener('click', (e) => {
                      //load data on click
                      load_attributes(entity, entity_searchable);

                      //shows combobox
                      tip.style.display = "none";
                      traitListContainer.style.top = e.clientY + 'px';
                      traitListContainer.style.left = e.clientX + 'px';
                      traitListContainer.style.display = "inline";

                      //prevents hiding zoomed elements 
                      if(zoomable.length >0){
                          if (e.target.closest(".brapi-zoomable")) return;
                          zoomable[0].style.display = "none";
                      }                    
                  });
              });

              // Hides zoom and combobox on click outside element
              svgContent.addEventListener('click', (e) => {
                  if (e.target.closest(".brapi-zoomable")) return;
                  svgContent.querySelectorAll(".brapi-zoomable").forEach(function(x) {
                      x.style.display = "none";
                  });
                  if (e.target.closest(".brapi-entity")) return;
                  traitListContainer.style.display = "none";
              });
          };

          xhr.open("GET", svg_file);
          xhr.responseType = "document";
          xhr.send();
          
          xhr.onerror = () => {
              console.log("Error while getting XML.");
          };     
      

          //get brapi data
          const brapi = BrAPI(brapi_endpoint, "2.0","auth");
          

          function load_attributes(entity,entitiesRelated){

              //Getting the attributes data
              if(!entity){
                  return;
              }
              document.getElementById(traits_div).innerHTML =  "";
              var svg_entity = document.querySelectorAll('[name="' + entity + '"]');
  console.log(svg_entity);
              if(svg_entity){

                  // var attributes = brapi.search_attributes({
                  var attributes = brapi.simple_brapi_call({
                          'defaultMethod': 'post',
                          'urlTemplate': '/search/attributes',
                          'params': {"traitEntities":entitiesRelated},
                          'behavior' : 'fork'
                  });

                  attributes.map(attribute => {
                      var traitDbIds = attribute.trait.map(trait =>{ 
                          // if(entity != trait.entity) return;
                          if(!trait.traitDbId) return;
                          return trait.traitDbId;
                      }).reduce(traitDbId =>{
                          return traitDbId !== null;
                      });
                      return traitDbIds;
                  }).all(ids =>{                    
                      load_table("#" + traits_div, '#' + filtered_table, ids);
                  });                   
                  
              }
          }

          function load_table(filterDiv, filterTable, attribute_ids, callback){

            
              if ($.fn.dataTable.isDataTable(filterTable)) { 
                  $(filterTable).DataTable().clear().destroy();
                  $(filterTable).empty();                       
              }            if(attribute_ids.length < 1) return;

              // var attributevalues = brapi.search_attributevalues({
              var attributevalues = brapi.simple_brapi_call({
                      'defaultMethod': 'post',
                      'urlTemplate': '/search/attributevalues?pageSize=100',
                      'params': {"attributeDbIds": attribute_ids                        
                      },
                      'behavior': 'fork'
              });

              currentGFilter = GraphicalFilter(
                  attributevalues,
                  baseTraits,
                  baseCols,
                  ["Accession","AccessionId"],
                  undefined,
                  false
              );
              currentGFilter.draw(
                  filterDiv,
                  filterTable,
              );

              function baseTraits(d) { 
                  var traits = {};
                  traits[d.attributeName] = d.value;
                  return traits;
              }
              function baseCols(d){
                  return {
                  'AccessionId':d.germplasmDbId,
                  'Accession':d.germplasmName,
                  }
              }

          }

      }
  }


  function brapiTraitSelector(){
      return new BrAPITraitSelector(...arguments);
    }

  return brapiTraitSelector;

}));
