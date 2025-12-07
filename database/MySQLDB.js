import mysql from "mysql2/promise";

class SQLManager {
  constructor(dbconfig) {
    this.sqldbconfig = dbconfig;
  }
  async connect() {
    try {
      this.sqldb = await mysql.createConnection(this.sqldbconfig);
      return this.sqldb;
    } catch (error) {
      throw error;
    }
  }
  async query(sql, params = []) {
    if (!this.sqldb) {
      throw new Error("Database not connected. Call connect() first.");
    }

    try {
      const result = await this.sqldb.query(sql, params);
      return result;
    } catch (error) {
      throw error;
    }
  }
  async delete(table, where = {}) {
    try {
      let sql;
      let values = [];
      if (!where || Object.keys(where).length === 0) {
        sql = `DELETE FROM ${table}`;
      } else {
        const keys = Object.keys(where);
        const conditions = keys.map((key) => `${key} = ?`).join(" AND ");
        values = keys.map((key) => where[key]);
        sql = `DELETE FROM ${table} WHERE ${conditions}`;
      }
      const result = await this.query(sql, values);
      return result;
    } catch (error) {
      throw error;
    }
  }
  async insert(table, data, keyCols = ["id"], deleteExisting = true) {
    try {
      if (!Array.isArray(data)) {
        data = [data];
      }
      if (deleteExisting) {
        console.log("in dele");
        if (data.length === 0) return null;
        this.delete(table);
      }
      const columns = Object.keys(data[0]);
      const placeholders = "(" + columns.map(() => "?").join(", ") + ")";
      const allValues = data.map((row) => columns.map((col) => row[col]));
      const flatValues = allValues.flat();
      const updateCols = columns.filter((col) => !keyCols?.includes(col));
      const sql = `
    INSERT INTO ${table} (${columns.join(", ")})
    VALUES ${allValues.map(() => placeholders).join(", ")}
    ON DUPLICATE KEY UPDATE ${updateCols
      .map((col) => `${col} = VALUES(${col})`)
      .join(", ")}
  `;
      const result = await this.query(sql, flatValues);
      return result;
    } catch (error) {
      console.log(error)
      throw error;
    }
  }
}

export default SQLManager;
