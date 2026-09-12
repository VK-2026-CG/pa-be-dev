import type { ContestBuilderVM, RuleExpressionVM, RulePredicateVM, ValidationIssueVM } from '../../../vendor/spec/contest-admin-vm.js';
import { getImportedCircular } from './imported-contests.js';

function predicates(node:RuleExpressionVM):RulePredicateVM[]{
  if(node.type==='PREDICATE')return [node];
  if(node.type==='NOT')return predicates(node.child);
  return node.children.flatMap(predicates);
}

export function validateImportedContest(builder:ContestBuilderVM):ValidationIssueVM[]{
  const imported=getImportedCircular(builder);if(!imported)return [];
  const issues:ValidationIssueVM[]=[];
  const citations=new Set(imported.citations.map(item=>item.citationId));
  const periods=new Set(imported.periods.map(item=>item.periodId));
  const add=(code:string,path:string)=>issues.push({issueId:`import_${issues.length+1}`,severity:'ERROR',code,path,messageKey:'contest.error.ruleInvalid',acknowledgementAllowed:false});
  const checkCitations=(ids:string[],path:string)=>ids.forEach(id=>{if(!citations.has(id))add('UNKNOWN_CITATION',path);});
  const active=(key:string,code:string)=>builder.catalogue.lovs.find(item=>item.key===key)?.values.some(value=>value.code===code&&value.status==='ACTIVE')===true;

  imported.audienceRules.forEach((rule,index)=>{
    checkCitations(rule.sourceCitationIds,`/audienceRules/${index}/sourceCitationIds`);
    rule.rankCodes.forEach(code=>{if(!active('agent.level',code))add('UNKNOWN_RANK',`/audienceRules/${index}/rankCodes`);});
  });
  imported.awardRules.forEach((rule,index)=>{
    checkCitations(rule.sourceCitationIds,`/awardRules/${index}/sourceCitationIds`);
    rule.options.forEach((option,optionIndex)=>{
      checkCitations(option.sourceCitationIds,`/awardRules/${index}/options/${optionIndex}/sourceCitationIds`);
      option.allOf.forEach((item,itemIndex)=>{
        const metricCode=item.metricCode.endsWith('_WEALTH_PLANNER')?'SOURCE_QUALIFICATION':item.metricCode;
        if(!builder.catalogue.metrics.some(metric=>metric.code===metricCode)||item.periodId&&!periods.has(item.periodId))add('UNKNOWN_THRESHOLD_REFERENCE',`/awardRules/${index}/options/${optionIndex}/allOf/${itemIndex}`);
        checkCitations(item.sourceCitationIds,`/awardRules/${index}/options/${optionIndex}/allOf/${itemIndex}/sourceCitationIds`);
      });
    });
  });
  for(const route of builder.configuration.qualification?.routes??[])for(const predicate of predicates(route.expression)){
    const path=`/routes/${route.routeId}/${predicate.nodeId}`;
    const metric=builder.catalogue.metrics.find(item=>item.code===predicate.metricCode);
    if(!metric){add('UNKNOWN_METRIC',path);continue;}
    if(predicate.context?.periodId&&!periods.has(predicate.context.periodId))add('UNKNOWN_PERIOD',`${path}/context/periodId`);
    const operand=predicate.operand;
    if(operand&&(operand.kind==='LOV'||operand.kind==='LOV_SET')){
      const codes=operand.kind==='LOV'?[operand.valueCode]:operand.valueCodes;
      if(metric.operandLovKey!==operand.lovKey||!builder.catalogue.lovs.some(item=>item.key===operand.lovKey))add('UNKNOWN_LOV',`${path}/operand`);
      else if(codes.some(code=>!active(operand.lovKey,code)))add('UNKNOWN_LOV_VALUE',`${path}/operand`);
    }
    checkCitations(predicate.sourceCitationIds??[],`${path}/sourceCitationIds`);
  }
  return issues;
}
