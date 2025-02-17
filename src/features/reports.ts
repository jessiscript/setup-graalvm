import * as c from '../constants'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as github from '@actions/github'
import {join} from 'path'
import {tmpdir} from 'os'
import {
  createPRComment,
  createRef,
  createTree, getPrBaseBranchMetrics,
  isPREvent,
  toSemVer
} from '../utils'
import {gte} from 'semver'

const BUILD_OUTPUT_JSON_PATH = join(tmpdir(), 'native-image-build-output.json')
const BYTES_TO_KiB = 1024
const BYTES_TO_MiB = 1024 * 1024
const BYTES_TO_GiB = 1024 * 1024 * 1024
const DOCS_BASE =
    'https://github.com/oracle/graal/blob/master/docs/reference-manual/native-image/BuildOutput.md'
const INPUT_NI_JOB_REPORTS = 'native-image-job-reports'
const INPUT_NI_PR_REPORTS = 'native-image-pr-reports'
const INPUT_NI_PR_COMPARISON = 'native-image-pr-comparison'
const INPUT_NI_PR_COMPARISON_PARAMETERS = 'native-image-pr-comparison-parameter'
const NATIVE_IMAGE_CONFIG_FILE = join(
    tmpdir(),
    'native-image-options.properties'
)
const NATIVE_IMAGE_CONFIG_FILE_ENV = 'NATIVE_IMAGE_CONFIG_FILE'

interface AnalysisResult {
  total: number
  reachable: number
  reflection: number
  jni: number
}

interface GeneralInfo {
  name: string
  graalvm_version: string
  java_version: string | null
  vendor_version?: string
  c_compiler: string | null
  garbage_collector: string
  graal_compiler?: {
    optimization_level: string
    march: string
    pgo?: string[]
  }
}

interface analysisResults {
  classes: AnalysisResult
  types?: AnalysisResult
  fields: AnalysisResult
  methods: AnalysisResult
}

interface BuildOutput {
  general_info: GeneralInfo
  analysis_results: analysisResults
  image_details: {
    total_bytes: number
    code_area: {
      bytes: number
      compilation_units: number
    }
    image_heap: {
      bytes: number
      objects?: {
        count: number
      }
      resources: {
        count: number
        bytes: number
      }
    }
    debug_info?: {
      bytes: number
    }
    runtime_compiled_methods?: {
      count: number
      graph_encoding_bytes: number
    }
  }
  resource_usage: {
    cpu: {
      load: number
      total_cores: number
    }
    garbage_collection: {
      count: number
      total_secs: number
    }
    memory: {
      system_total: number
      peak_rss_bytes: number
    }
    total_secs?: number
  }
}

export async function setUpNativeImageBuildReports(
    isGraalVMforJDK17OrLater: boolean,
    graalVMVersion: string,
): Promise<void> {
  const isRequired = areJobReportsEnabled() || arePRReportsEnabled()
  if (!isRequired) {
    return
  }
  const isSupported =
      isGraalVMforJDK17OrLater ||
      graalVMVersion === c.VERSION_LATEST ||
      graalVMVersion === c.VERSION_DEV ||
      (!graalVMVersion.startsWith(c.MANDREL_NAMESPACE) &&
          gte(toSemVer(graalVMVersion), '22.2.0'))
  if (!isSupported) {
    core.warning(
        `Build reports for PRs and job summaries are only available in GraalVM 22.2.0 or later. This build job uses GraalVM ${graalVMVersion}.`
    )
    return
  }
  core.info(`DEBUGGING: -H:BuildOutputJSONFile=${BUILD_OUTPUT_JSON_PATH.replace(/\\/g, '\\\\')}`)
  setNativeImageOption(
      `-H:BuildOutputJSONFile=${BUILD_OUTPUT_JSON_PATH.replace(/\\/g, '\\\\')}`
  )// Escape backslashes for Windows
}

export async function generateReports(): Promise<void> {
  if (areJobReportsEnabled() || arePRReportsEnabled()) {
    if (!fs.existsSync(BUILD_OUTPUT_JSON_PATH)) {
      core.warning(
          'Unable to find build output data to create a report. Are you sure this build job has used GraalVM Native Image?'
      )
      return
    }
    const buildOutput: BuildOutput = JSON.parse(
        fs.readFileSync(BUILD_OUTPUT_JSON_PATH, 'utf8')
    )

    const report = createReport(buildOutput)
    if (areJobReportsEnabled()) {
      core.summary.addRaw(report)
      await core.summary.write()
    }
    if (arePRReportsEnabled() && !arePRBaseComparisonEnabled()) {
      await createPRComment(report)
    }

    const treeSha = await createTree(JSON.stringify(buildOutput))
    await createRef(treeSha)

    if (arePRBaseComparisonEnabled()) {
      const compareBranchBuildOutput: BuildOutput = JSON.parse(await getPrBaseBranchMetrics())
      const prReport = createReport(buildOutput, compareBranchBuildOutput)
      await createPRComment(prReport)
      const prMetrics: BuildOutput = JSON.parse(
          await getPrBaseBranchMetrics()
      )
      await createPRComment(createPRComparison(buildOutput, prMetrics))
    }
  }
}

function areJobReportsEnabled(): boolean {
  return core.getInput(INPUT_NI_JOB_REPORTS) === 'true'
}

function arePRReportsEnabled(): boolean {
  return isPREvent() && core.getInput(INPUT_NI_PR_REPORTS) === 'true'
}

function arePRBaseComparisonEnabled(): boolean {
  return isPREvent() && core.getInput(INPUT_NI_PR_COMPARISON) === 'true'
}

function getPRComparePara(): string {
  return core.getInput(INPUT_NI_PR_COMPARISON_PARAMETERS)
}

function getNativeImageOptionsFile(): string {
  let optionsFile = process.env[NATIVE_IMAGE_CONFIG_FILE_ENV]
  if (optionsFile === undefined) {
    optionsFile = NATIVE_IMAGE_CONFIG_FILE
    core.exportVariable(NATIVE_IMAGE_CONFIG_FILE_ENV, optionsFile)
  }
  return optionsFile
}

function setNativeImageOption(value: string): void {
  const optionsFile = getNativeImageOptionsFile()
  if (fs.existsSync(optionsFile)) {
    fs.appendFileSync(optionsFile, ` ${value}`)
  } else {
    fs.writeFileSync(optionsFile, `NativeImageArgs = ${value}`)
  }
}

function createPRComparison(dataRecent: BuildOutput, dataBase: BuildOutput): string {
  const analysisRecent = dataRecent.analysis_results
  const analysisTypesRecent = analysisRecent.types ? analysisRecent.types : analysisRecent.classes
  const analysisBase = dataBase.analysis_results
  const analysisTypesBase = analysisRecent.types ? analysisBase.types : analysisBase.classes
  const detailsRecent = dataRecent.image_details
  const detailsBase = dataBase.image_details
  const debugInfoBytesRecent = detailsBase.debug_info ? detailsBase.debug_info.bytes : 0
  const debugInfoBytesBase = detailsBase.debug_info ? detailsBase.debug_info.bytes : 0
  const otherBytesRecent =
      detailsRecent.total_bytes -
      detailsRecent.code_area.bytes -
      detailsRecent.image_heap.bytes -
      debugInfoBytesRecent
  const otherBytesBase =
      detailsBase.total_bytes -
      detailsBase.code_area.bytes -
      detailsBase.image_heap.bytes -
      debugInfoBytesBase
  const resourcesRecent = dataRecent.resource_usage
  const resourcesBase = dataBase.resource_usage

  const baseBranch = process.env.GITHUB_BASE_REF
  const recentBranch = process.env.GITHUB_HEAD_REF

  const compareParameter = getPRComparePara().toLowerCase()

  return `## GraalVM Native Image PR comparison

${compareParameter.includes('analysis results')? createComparedAnalysisResultsDiagramm(recentBranch, baseBranch, analysisRecent, analysisTypesRecent, analysisBase, analysisTypesBase): ''}
${compareParameter.includes('image details')? createComparedDetailsDiagramm(recentBranch, baseBranch, detailsRecent, detailsBase, otherBytesBase, otherBytesRecent): ''}
${compareParameter.includes('resource usage')? createComparedResourceUsageDiagramm(recentBranch, baseBranch, resourcesRecent, resourcesBase): ''}

${getFooter()}`
}

function createComparedDetailsDiagramm(recentBranch: string | undefined, baseBranch: string | undefined, detailsRecent: any, detailsBase: any, otherBytesBase: number, otherBytesRecent: number): string {
  return`#### Image Details

\`\`\`mermaid
gantt
    title Native Image Size Details 
    todayMarker off
    dateFormat  X
    axisFormat %

    section Code area
    ${recentBranch} (${bytesToHuman(detailsRecent.code_area.bytes)}): active, 0, ${detailsRecent.code_area.bytes}
    ${baseBranch} (${bytesToHuman(detailsBase.code_area.bytes)}): 0, ${detailsBase.code_area.bytes}
    
    section Image heap
    ${recentBranch} (${bytesToHuman(detailsRecent.image_heap.bytes)}): active, 0, ${detailsRecent.image_heap.bytes}
    ${baseBranch} (${bytesToHuman(detailsBase.image_heap.bytes)}): 0, ${detailsBase.image_heap.bytes}
    
    section Other data
    ${recentBranch} (${bytesToHuman(otherBytesRecent)}): active, 0, ${otherBytesRecent}
    ${baseBranch} (${bytesToHuman(otherBytesBase)}): 0, ${otherBytesBase}

    section Total
    ${recentBranch} (${bytesToHuman(detailsRecent.total_bytes)})   : active, 0, ${detailsRecent.total_bytes}
    ${baseBranch} (${bytesToHuman(detailsBase.total_bytes)})   : 0, ${detailsBase.total_bytes}
\`\`\`
`
}

function createComparedAnalysisResultsDiagramm(recentBranch: string | undefined, baseBranch: string | undefined, analysisRecent: any, analysisTypesRecent: any, analysisBase: any, analysisTypeBase: any): string {
  return`#### Analysis Results

\`\`\`mermaid
gantt
    title Native Image Analysis Results 
    todayMarker off
    dateFormat  X
    axisFormat %

    section Types
    ${recentBranch} ${analysisTypesRecent.reachable} (Reachable): active, 0, ${analysisTypesRecent.reachable}
    ${baseBranch} ${analysisTypeBase.reachable} (Reachable): 0, ${analysisTypeBase.reachable}
    ${recentBranch} ${analysisTypesRecent.reflection} (Reflection): active, 0, ${analysisTypesRecent.reflection}
    ${baseBranch} ${analysisTypeBase.reflection} (Reflection): 0, ${analysisTypeBase.reflection}
    ${recentBranch} ${analysisTypesRecent.jni} (JNI): active, 0, ${analysisTypesRecent.jni}
    ${baseBranch} ${analysisTypeBase.jni} (JNI): 0, ${analysisTypeBase.jni}
    ${recentBranch} ${analysisTypesRecent.total} (Total Loaded): active, 0, ${analysisTypesRecent.total}
    ${baseBranch} ${analysisTypeBase.total} (Total Loaded): 0, ${analysisTypeBase.total}
    
    section Fields
    ${recentBranch} ${analysisRecent.fields.reachable} (Reachable): active, 0, ${analysisRecent.fields.reachable}
    ${baseBranch} ${analysisBase.fields.reachable} (Reachable): 0, ${analysisBase.fields.reachable}
    ${recentBranch} ${analysisRecent.fields.reflection} (Reflection): active, 0, ${analysisRecent.fields.reflection}
    ${baseBranch} ${analysisBase.fields.reflection} (Reflection): 0, ${analysisBase.fields.reflection}
    ${recentBranch} ${analysisRecent.fields.jni} (JNI): active, 0, ${analysisRecent.fields.jni}
    ${baseBranch} ${analysisBase.fields.jni} (JNI): 0, ${analysisBase.fields.jni}
    ${recentBranch} ${analysisRecent.fields.total} (Total Loaded): active, 0, ${analysisRecent.fields.total}
    ${baseBranch} ${analysisBase.fields.total} (Total Loaded): 0, ${analysisBase.fields.total}
    
    section Methods
    ${recentBranch} ${analysisRecent.methods.reachable} (Reachable): active, 0, ${analysisRecent.methods.reachable}
    ${baseBranch} ${analysisBase.methods.reachable} (Reachable): 0, ${analysisBase.methods.reachable}
    ${recentBranch} ${analysisRecent.methods.reflection} (Reflection): active, 0, ${analysisRecent.methods.reflection}
    ${baseBranch} ${analysisBase.methods.reflection} (Reflection): 0, ${analysisBase.methods.reflection}
    ${recentBranch} ${analysisRecent.methods.jni} (JNI): active, 0, ${analysisRecent.methods.jni}
    ${baseBranch} ${analysisBase.methods.jni} (JNI): 0, ${analysisBase.methods.jni}
    ${recentBranch} ${analysisRecent.methods.total} (Total Loaded): active, 0, ${analysisRecent.methods.total}
    ${baseBranch} ${analysisBase.methods.total} (Total Loaded): 0, ${analysisBase.methods.total}
\`\`\`
`
}

function createComparedResourceUsageDiagramm(recentBranch: string | undefined, baseBranch: string | undefined, resourcesRecent: any, resourcesBase: any): string {
  return`#### Resource Usage

\`\`\`mermaid
gantt
    title Native Image Resource Usage
    todayMarker off
    dateFormat  X
    axisFormat %

    section Garbage Collection
    ${recentBranch} (${resourcesRecent.garbage_collection.total_secs}s): active, 0, 100
    ${baseBranch} (${resourcesBase.garbage_collection.total_secs}s): 0, ${normalizeValue(resourcesBase.garbage_collection.total_secs, resourcesRecent.garbage_collection.total_secs)}
    
    section Peak RSS
    ${recentBranch} (${bytesToHuman(resourcesRecent.memory.peak_rss_bytes)}): active, 0, 100
    ${baseBranch} (${bytesToHuman(resourcesBase.memory.peak_rss_bytes)}): 0, ${normalizeValue(resourcesBase.memory.peak_rss_bytes, resourcesRecent.memory.peak_rss_bytes)}
    
    section CPU Load
    ${recentBranch} (${bytesToHuman(resourcesRecent.cpu.load)}): active, 0, 100
    ${baseBranch} (${bytesToHuman(resourcesBase.cpu.load)}): 0, ${normalizeValue(resourcesBase.cpu.load, resourcesRecent.cpu.load)}
\`\`\`
`
}

function normalizeValue(value: number, baseValue: number): string {
  return ((value / baseValue) * 100).toFixed(0)
}

function createReport(data: BuildOutput, compareData: BuildOutput | null = null): string {
  const context = github.context
  const info = data.general_info
  const analysis = data.analysis_results
  const analysisTypes = analysis.types ? analysis.types : analysis.classes
  const details = data.image_details
  let objectCount = ''
  if (details.image_heap.objects) {
    objectCount = `${details.image_heap.objects.count.toLocaleString()} objects, `
  }
  const debugInfoBytes = details.debug_info ? details.debug_info.bytes : 0
  const otherBytes =
      details.total_bytes -
      details.code_area.bytes -
      details.image_heap.bytes -
      debugInfoBytes
  let debugInfoLine = getDebugInfoLine(details, debugInfoBytes)
  let versionLine = getVersionLine(info)
  let graalLine = getGraalLine(info)

  const resources = data.resource_usage

  let totalTime = getTotalTime(resources)
  let gcTotalTimeRatio = getTotalTimeRatio(resources)

  let compareBranch = null
  let compareDetails = null
  let compareDebugInfoBytes = null
  let compareOtherBytes = null
  let compareResources = null
  let compareAnalysis = null
  let compareAnalysisTypes = null
  if (compareData !== null) {
    compareBranch = process.env.GITHUB_BASE_REF
    compareDetails = compareData.image_details
    compareDebugInfoBytes = compareDetails.debug_info ? compareDetails.debug_info.bytes : 0
    compareOtherBytes =
        compareDetails.total_bytes -
        compareDetails.code_area.bytes -
        compareDetails.image_heap.bytes -
        compareDebugInfoBytes
    compareResources = compareData.resource_usage
    compareAnalysis = compareData.analysis_results
    compareAnalysisTypes = compareAnalysis.types ? compareAnalysis.types : compareAnalysis.classes
  }

  return `${getReportHeader(info, totalTime, context)}
${getEnvironmentTable(versionLine, graalLine, info)}
${getAnalysisTable(analysis, analysisTypes, compareAnalysis, compareAnalysisTypes, compareBranch)}
${getDetailsTable(details, objectCount, debugInfoLine, otherBytes, compareDetails, compareBranch, compareOtherBytes)}
${getResourceUsageTable(resources, gcTotalTimeRatio, compareResources, compareBranch)}
${getFooter()}`
}

function getDebugInfoLine(details: any, debugInfoBytes: number): string {
  if (details.debug_info) {
    return `
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-debug-info" target="_blank">Debug info</a></td>
      <td align="right">${bytesToHuman(debugInfoBytes)}</td>
      <td align="right">${toPercent(debugInfoBytes, details.total_bytes)}</td>
      <td align="left"></td>
    </tr>`
  }
  return ''
}

function getVersionLine(info: GeneralInfo): string {
  if (info.vendor_version) {
    return `
    <tr>
      <td><a href="${DOCS_BASE}#glossary-java-info" target="_blank">Java version</a></td>
      <td>${info.java_version}</td>
      <td><a href="${DOCS_BASE}#glossary-java-info" target="_blank">Vendor version</a></td>
      <td>${info.vendor_version}</td>
    </tr>`
  }
  return `
  <tr>
    <td><a href="${DOCS_BASE}#glossary-version-info" target="_blank">GraalVM version</a></td>
    <td>${info.graalvm_version}</td>
    <td><a href="${DOCS_BASE}#glossary-java-version-info" target="_blank">Java version</a></td>
    <td>${info.java_version}</td>
  </tr>`
}

function getGraalLine(info: any): string {
  if (info.graal_compiler) {
    let pgoSuffix = ''
    const isOracleGraalVM =
        info.vendor_version && info.vendor_version.includes('Oracle GraalVM')
    if (isOracleGraalVM) {
      const pgo = info.graal_compiler.pgo
      const pgoText = pgo ? pgo.join('+') : 'off'
      pgoSuffix = `, <a href="${DOCS_BASE}#recommendation-pgo" target="_blank">PGO</a>: ${pgoText}`
    }
    return `
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-graal-compiler" target="_blank">Graal compiler</a></td>
      <td colspan="3">
        optimization level: ${info.graal_compiler.optimization_level},
        target machine: ${info.graal_compiler.march}${pgoSuffix}
      </td>
    </tr>`
  }
  return ''
}

function getTotalTime(resources: any): string {
  if (resources.total_secs) {
    return ` in ${secondsToHuman(resources.total_secs)}`
  }
  return ''
}

function getTotalTimeRatio(resources: any): string {
  if (resources.total_secs) {
    return ` (${toPercent(
        resources.garbage_collection.total_secs,
        resources.total_secs
    )} of total time)`
  }
  return ''
}

function getReportHeader(info: any, totalTime: string, context: any): string {
  return `## GraalVM Native Image Build Report

\`${info.name}\` generated${totalTime} as part of the '${
      context.job
  }' job in run <a href="${context.serverUrl}/${context.repo.owner}/${
      context.repo.repo
  }/actions/runs/${context.runId}" target="_blank">#${context.runNumber}</a>.
`
}

function getEnvironmentTable(versionLine: string, graalLine: string, info: any): string {
  return `#### Environment

<table>${versionLine}${graalLine}
  <tr>
    <td><a href="${DOCS_BASE}#glossary-ccompiler" target="_blank">C compiler</a></td>
    <td colspan="3">${info.c_compiler}</td>
  </tr>
  <tr>
    <td><a href="${DOCS_BASE}#glossary-gc" target="_blank">Garbage collector</a></td>
    <td colspan="3">${info.garbage_collector}</td>
  </tr>
</table>
`
}

function getAnalysisTable(analysis: any, analysisTypes: any, compareAnalysis: any, compareAnalysisType: any, compareBranch: any): string {
return `#### Analysis Results

<table>
  <thead>
    <tr>
      <th align="left">Category</th>
      <th align="right">Types</th>
      <th align="right">in %</th>${getCompareTableHeader(compareBranch)}
      <th align="right">Fields</th>
      <th align="right">in %</th>${getCompareTableHeader(compareBranch)}
      <th align="right">Methods</th>
      <th align="right">in %</th>${getCompareTableHeader(compareBranch)}
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-reachability" target="_blank">Reachable</a></td>
      <td align="right">${analysisTypes.reachable.toLocaleString()}</td>
      <td align="right">${toPercent(
      analysisTypes.reachable,
      analysisTypes.total
      )}</td>${compareAnalysisType !== null? getCompareColumn(analysisTypes.reachable, compareAnalysisType.reachable, 98, 108): ''}
      <td align="right">${analysis.fields.reachable.toLocaleString()}</td>
      <td align="right">${toPercent(
      analysis.fields.reachable,
      analysis.fields.total
      )}</td>${compareAnalysis !== null? getCompareColumn(analysis.fields.reachable, compareAnalysis.fields.reachable, 98, 108): ''}
      <td align="right">${analysis.methods.reachable.toLocaleString()}</td>
      <td align="right">${toPercent(
      analysis.methods.reachable,
      analysis.methods.total
      )}</td>${compareAnalysis !== null? getCompareColumn(analysis.methods.reachable, compareAnalysis.methods.reachable, 98, 108): ''}
    </tr>
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-reflection-registrations" target="_blank">Reflection</a></td>
      <td align="right">${analysisTypes.reflection.toLocaleString()}</td>
      <td align="right">${toPercent(
      analysisTypes.reflection,
      analysisTypes.total
      )}</td>${compareAnalysisType !== null? getCompareColumn(analysisTypes.reflection, compareAnalysisType.reflection, 98, 108): ''}
      <td align="right">${analysis.fields.reflection.toLocaleString()}</td>
      <td align="right">${toPercent(
      analysis.fields.reflection,
      analysis.fields.total
      )}</td>${compareAnalysis !== null? getCompareColumn(analysis.fields.reflection, compareAnalysis.fields.reflection, 98, 108): ''}
      <td align="right">${analysis.methods.reflection.toLocaleString()}</td>
      <td align="right">${toPercent(
      analysis.methods.reflection,
      analysis.methods.total
      )}</td>${compareAnalysis !== null? getCompareColumn(analysis.methods.reflection, compareAnalysis.methods.reflection, 98, 108): ''}
    </tr>
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-jni-access-registrations" target="_blank">JNI</a></td>
      <td align="right">${analysisTypes.jni.toLocaleString()}</td>
      <td align="right">${toPercent(
      analysisTypes.jni,
      analysisTypes.total
      )}</td>${compareAnalysisType !== null? getCompareColumn(analysisTypes.jni, compareAnalysisType.jni, 98, 108): ''}
      <td align="right">${analysis.fields.jni.toLocaleString()}</td>
      <td align="right">${toPercent(
      analysis.fields.jni,
      analysis.fields.total
      )}</td>${compareAnalysis !== null? getCompareColumn(analysis.fields.jni, compareAnalysis.fields.jni, 98, 108): ''}
      <td align="right">${analysis.methods.jni.toLocaleString()}</td>
      <td align="right">${toPercent(
      analysis.methods.jni,
      analysis.methods.total
      )}</td>${compareAnalysis !== null? getCompareColumn(analysis.methods.jni, compareAnalysis.methods.jni, 98, 108): ''}
    </tr>
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-reachability" target="_blank">Loaded</a></td>
      <td align="right">${analysisTypes.total.toLocaleString()}</td>
      <td align="right">100.000%</td>${compareAnalysisType !== null? getCompareColumn(analysisTypes.total, compareAnalysisType.total, 98, 108): ''}
      <td align="right">${analysis.fields.total.toLocaleString()}</td>
      <td align="right">100.000%</td>${compareAnalysis !== null? getCompareColumn(analysis.fields.total, compareAnalysis.fields.total, 98, 108): ''}
      <td align="right">${analysis.methods.total.toLocaleString()}</td>
      <td align="right">100.000%</td>${compareAnalysis !== null? getCompareColumn(analysis.methods.total, compareAnalysis.methods.total, 98, 108): ''}
    </tr>
  </tbody>
</table>
`
}

function getDetailsTable(details: any, objectCount: string, debugInfoLine: string, otherBytes: number, compareDetails: any, compareBranch: any, compareOtherBytes: number| null): string {
  return `#### Image Details

<table>
  <thead>
    <tr>
      <th align="left">Category</th>
      <th align="right">Size</th>
      <th align="right">in %</th>${getCompareTableHeader(compareBranch)}
      <th align="left">Details</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-code-area" target="_blank">Code area</a></td>
      <td align="right">${bytesToHuman(details.code_area.bytes)}</td>
      <td align="right">${toPercent(
        details.code_area.bytes,
        details.total_bytes
    )}</td>${compareDetails !== null? getCompareColumnBytes(details.code_area.bytes, compareDetails.code_area.bytes, 98, 110): ''}
      <td align="left">${details.code_area.compilation_units.toLocaleString()} compilation units</td>
    </tr>
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-image-heap" target="_blank">Image heap</a></td>
      <td align="right">${bytesToHuman(details.image_heap.bytes)}</td>
      <td align="right">${toPercent(
        details.image_heap.bytes,
        details.total_bytes
    )}</td>${compareDetails !== null? getCompareColumnBytes(details.image_heap.bytes, compareDetails.image_heap.bytes, 98, 110): ''}
      <td align="left">${objectCount}${bytesToHuman(
        details.image_heap.resources.bytes
    )} for ${details.image_heap.resources.count.toLocaleString()} resources</td>
    </tr>${debugInfoLine}
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-other-data" target="_blank">Other data</a></td>
      <td align="right">${bytesToHuman(otherBytes)}</td>
      <td align="right">${toPercent(otherBytes, details.total_bytes)}</td>${compareOtherBytes !== null? getCompareColumnBytes(otherBytes, compareOtherBytes, 98, 110): ''}
      <td align="left"></td>
    </tr>
    <tr>
      <td align="left">Total</td>
      <td align="right"><strong>${bytesToHuman(
        details.total_bytes
    )}</strong></td>
      <td align="right">100.000%</td>${compareDetails !== null? getCompareColumnBytes(details.total_bytes, compareDetails.total_bytes, 98, 110): ''}
      <td align="left"></td>
    </tr>
  </tbody>
</table>
`
}

function getResourceUsageTable(resources: any, gcTotalTimeRatio: string, compareResources: any, compareBranch: any): string {
  return `#### Resource Usage

<table>${getResourcesUsageHeader(compareBranch)}
  <tbody>
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-garbage-collections" target="_blank">Garbage collection</a></td>
      <td align="left">${resources.garbage_collection.total_secs.toFixed(
      2
  )}s${gcTotalTimeRatio} in ${resources.garbage_collection.count} GCs</td>${compareResources !== null? getCompareColumnTime(resources.garbage_collection.total_secs, compareResources.garbage_collection.total_secs, 98, 108): ''}
    </tr>
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-peak-rss" target="_blank">Peak RSS</a></td>
      <td align="left">${bytesToHuman(
      resources.memory.peak_rss_bytes
  )} (${toPercent(
      resources.memory.peak_rss_bytes,
      resources.memory.system_total
  )} of ${bytesToHuman(resources.memory.system_total)} system memory)</td>${compareResources !== null? getCompareColumnBytes(resources.memory.peak_rss_bytes, compareResources.memory.peak_rss_bytes, 98, 108): ''}
    </tr>
    <tr>
      <td align="left"><a href="${DOCS_BASE}#glossary-cpu-load" target="_blank">CPU load</a></td>
      <td align="left">${resources.cpu.load.toFixed(3)} (${toPercent(
      resources.cpu.load,
      resources.cpu.total_cores
  )} of ${resources.cpu.total_cores} CPU cores)</td>${compareResources !== null? getCompareColumn(resources.cpu.load, compareResources.cpu.load, 98, 108): ''}
    </tr>
  </tbody>
</table>
`
}

function getResourcesUsageHeader(compareBranch: string | null): string {
  if (compareBranch === null) {
    return ''
  }
  return `<thead>
    <tr>
      <th align="left">Category</th>
      <th align="right">Resources</th>${getCompareTableHeader(compareBranch)}
    </tr>
  </thead>`
}

function getFooter(): string {
  return `<em>Report generated by <a href="https://github.com/marketplace/actions/github-action-for-graalvm" target="_blank">setup-graalvm</a>.</em>`
}

function getCompareTableHeader(compareBranch: string | null): string {
  if (compareBranch === null) {return ''}
  return`<th align="left">Compared to <i>${compareBranch}</i></th>`
}

function getCompareColumnTime(value: number, compareValue: number | null, lowerPercentageBoarder: number, higherPercentageBoarder: number, smallIsPositive: boolean = true): string {
  if (compareValue === null) {return ''}
  if (smallIsPositive) {
    return `<td align="left">
${((value / compareValue)*100) < lowerPercentageBoarder ? `:green_circle: ${(value - compareValue).toFixed(2)}s (${getDiffPercent(compareValue, value)}) :green_circle:`: ''}
${lowerPercentageBoarder < ((value / compareValue)*100) && ((value / compareValue)*100) < higherPercentageBoarder ? `${(value - compareValue).toFixed(2)}s (${getDiffPercent(compareValue, value)})`: ''}
${((value / compareValue)*100) > higherPercentageBoarder ? `:red_circle: ${(value - compareValue).toFixed(2)}s (${getDiffPercent(compareValue, value)}) :red_circle:`: ''}
</td>`
  }
  return `<td align="left">
${((value / compareValue)*100) < lowerPercentageBoarder ? `:red_circle: ${(value - compareValue).toFixed(2)}s (${getDiffPercent(compareValue, value)}) :red_circle:`: ''}
${lowerPercentageBoarder < ((value / compareValue)*100) && ((value / compareValue)*100) < higherPercentageBoarder ? `${(value - compareValue).toFixed(2)}s (${getDiffPercent(compareValue, value)})`: ''}
${((value / compareValue)*100) > higherPercentageBoarder ? `:green_circle: ${(value - compareValue).toFixed(2)}s (${getDiffPercent(compareValue, value)}) :green_circle:`: ''}
</td>`
}

function getCompareColumnBytes(value: number, compareValue: number | null, lowerPercentageBoarder: number, higherPercentageBoarder: number, smallIsPositive: boolean = true): string {
  if (compareValue === null) {return ''}
  if (smallIsPositive) {
    return `<td align="left">
${((value / compareValue)*100) < lowerPercentageBoarder ? `:green_circle: ${bytesToHuman(value - compareValue)} (${getDiffPercent(compareValue, value)}) :green_circle:`: ''}
${lowerPercentageBoarder < ((value / compareValue)*100) && ((value / compareValue)*100) < higherPercentageBoarder ? `${bytesToHuman(value - compareValue)} (${getDiffPercent(compareValue, value)})`: ''}
${((value / compareValue)*100) > higherPercentageBoarder ? `:red_circle: ${bytesToHuman(value - compareValue)} (${getDiffPercent(compareValue, value)}) :red_circle:`: ''}
</td>`
  }
  return `<td align="left">
${((value / compareValue)*100) < lowerPercentageBoarder ? `:red_circle: ${bytesToHuman(value - compareValue)} (${getDiffPercent(compareValue, value)}) :red_circle:`: ''}
${lowerPercentageBoarder < ((value / compareValue)*100) && ((value / compareValue)*100) < higherPercentageBoarder ? `${bytesToHuman(value - compareValue)} (${getDiffPercent(compareValue, value)})`: ''}
${((value / compareValue)*100) > higherPercentageBoarder ? `:green_circle: ${bytesToHuman(value - compareValue)} (${getDiffPercent(compareValue, value)}) :green_circle:`: ''}
</td>`
}

function getCompareColumn(value: number, compareValue: number | null, lowerPercentageBoarder: number, higherPercentageBoarder: number, smallIsPositive: boolean = true): string {
  if (compareValue === null) {return ''}
  if (smallIsPositive) {
    return `<td align="left">
${((value / compareValue)*100) < lowerPercentageBoarder ? `:green_circle: ${(value - compareValue).toFixed(2)} (${getDiffPercent(compareValue, value)}) :green_circle:`: ''}
${lowerPercentageBoarder < ((value / compareValue)*100) && ((value / compareValue)*100) < higherPercentageBoarder ? `${(value - compareValue).toFixed(2)} (${getDiffPercent(compareValue, value)})`: ''}
${((value / compareValue)*100) > higherPercentageBoarder ? `:red_circle: ${(value - compareValue).toFixed(2)} (${getDiffPercent(compareValue, value)}) :red_circle:`: ''}
</td>`
  }
  return `<td align="left">
${((value / compareValue)*100) < lowerPercentageBoarder ? `:red_circle: ${(value - compareValue).toFixed(2)} (${getDiffPercent(compareValue, value)}) :red_circle:`: ''}
${lowerPercentageBoarder < ((value / compareValue)*100) && ((value / compareValue)*100) < higherPercentageBoarder ? `${(value - compareValue).toFixed(2)} (${getDiffPercent(compareValue, value)})`: ''}
${((value / compareValue)*100) > higherPercentageBoarder ? `:green_circle: ${(value - compareValue).toFixed(2)} (${getDiffPercent(compareValue, value)}) :green_circle:`: ''}
</td>`
}

function toPercent(part: number, total: number): string {
  return `${((part / total) * 100).toFixed(3)}%`
}

function getDiffPercent(baseValue: number, recentValue: number):string {
  let sign = '+'
  if (recentValue < baseValue) {
    sign = '-'
  }
  return `${sign}${(Math.abs(recentValue-baseValue) / baseValue * 100).toFixed(3)}%`
}

function bytesToHuman(bytes: number): string {
  if (Math.abs(bytes) < BYTES_TO_KiB) {
    return `${bytes.toFixed(2)}B`
  } else if (Math.abs(bytes) < BYTES_TO_MiB) {
    return `${(bytes / BYTES_TO_KiB).toFixed(2)}KB`
  } else if (Math.abs(bytes) < BYTES_TO_GiB) {
    return `${(bytes / BYTES_TO_MiB).toFixed(2)}MB`
  } else {
    return `${(bytes / BYTES_TO_GiB).toFixed(2)}GB`
  }
}

function secondsToHuman(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  } else {
    return `${Math.trunc(seconds / 60)}m ${Math.trunc(seconds % 60)}s`
  }
}
