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
    //     // Delete specific row by id
    // await db.delete("header_fields", { id: "abc123" });

    // // Delete by multiple conditions
    // await db.delete("header_fields", { field_name: "InvoiceNo", field_type: "string" });

    // // ❗ Delete all rows (no params)
    // await db.delete("header_fields");
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
        if (data.length === 0) return null;
        this.delete(table);
      }


      const columns = Object.keys(data[0]);
      const placeholders = "(" + columns.map(() => "?").join(", ") + ")";
      const allValues = data.map((row) => columns.map((col) => row[col]));
      const flatValues = allValues.flat();
      console.log("Columns:", columns);
      const updateCols = columns.filter((col) => !keyCols?.includes(col));
      console.log("Update Columns:", updateCols);

      const sql = `
    INSERT INTO ${table} (${columns.join(", ")})
    VALUES ${allValues.map(() => placeholders).join(", ")}
    ON DUPLICATE KEY UPDATE ${updateCols
      .map((col) => `${col} = VALUES(${col})`)
      .join(", ")}
  `;

      console.log("Insert SQL:", sql);
      console.log("With values:", flatValues);

      const result = await this.query(sql, flatValues);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

export default SQLManager;
