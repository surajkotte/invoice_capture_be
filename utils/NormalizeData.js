const normalizeResponseData = (responseData) => {
  if (responseData?.header) {
    return {
      header: responseData?.header || [],
      items: responseData?.items || [],
    };
  } else if (responseData?.header_fields) {
    const { header_fields, item_fields } = responseData;
    return {
      header: header_fields,
      items: item_fields || [],
    };
  } else {
    const { items, ...rest } = responseData;
    return {
      header: rest,
      items: items || [],
    };
  }
};

export default normalizeResponseData;
