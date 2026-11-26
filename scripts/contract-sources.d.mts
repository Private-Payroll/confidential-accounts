/** The types of scripts/contract-sources.mjs: the files a contract is compiled from, read off its source. */
export interface ContractRow {
  readonly source: string;
  readonly compiled: string;
  readonly name: string;
  readonly builtFrom: readonly string[];
  readonly links: Readonly<Record<string, string>>;
}
export type ContractName = 'account' | 'vault' | 'registry';
export declare const CONTRACT_TABLE: Readonly<Record<ContractName, ContractRow>>;
export declare const CONTRACTS: Readonly<Record<ContractName, string>>;
export declare const COMPILED_INTO: Readonly<Record<ContractName, string>>;
export declare const WITNESSES: string;
export declare function tableRefusals(table: Readonly<Record<string, unknown>>): string[];
export declare function blank(src: string, strings: boolean): string;
export declare function statementsOf(text: string, file: string): { line: number; text: string; path?: string }[];
export declare function contractSources(root: string, main: string): string[];
export declare function contractSourceText(root: string, main: string): string;
export declare function codeOf(text: string): string;
export declare function moduleStateOf(text: string, file: string): string[];
