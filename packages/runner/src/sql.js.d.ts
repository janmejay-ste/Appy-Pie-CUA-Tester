declare module 'sql.js' {
  export interface Database {
    run(sql: string, params?: any[]): Database;
    exec(sql: string): QueryResults[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface Statement {
    bind(params?: any[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, any>;
    free(): boolean;
  }

  export interface QueryResults {
    columns: string[];
    values: any[][];
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export default function initSqlJs(config?: any): Promise<SqlJsStatic>;
}
