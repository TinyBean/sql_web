export interface DefaultDashboardAnalysisConfig {
  readonly cwd: string;
  readonly agentDir: string;
  readonly artifactDir: string;
  readonly provider: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface DefaultDashboardGenerationConfig {
  readonly databasePath: string;
  readonly analysis: DefaultDashboardAnalysisConfig;
}
