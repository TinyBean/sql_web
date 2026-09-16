export interface DefaultDashboardAnalysisConfig {
  readonly cwd: string;
  readonly agentDir: string;
  readonly artifactDir: string;
  readonly provider: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly codeInterpreter: {
    readonly pythonPath: string;
    readonly bwrapPath: string;
    readonly prlimitPath: string;
  };
}

export interface DefaultDashboardGenerationConfig {
  readonly databasePath: string;
  readonly analysis: DefaultDashboardAnalysisConfig;
}
