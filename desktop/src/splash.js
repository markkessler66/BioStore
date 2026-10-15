window.biostoreShowError = function (message) {
  const status = document.getElementById("status");
  const error = document.getElementById("error");
  status.textContent = "BioStore did not start.";
  error.hidden = false;
  error.textContent = message;
};
